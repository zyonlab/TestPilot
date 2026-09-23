import type { WalletSignatureReceipt } from "../domain/injectedSessionEvidence.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "puppeteer";
import { Wallet, JsonRpcProvider, getBytes } from "ethers";
import type { ChainConfig } from "../types.js";
import { walletsDir } from "../env.js";

// Same story as wallet.ts: this used to be resolved from __dirname inside the gateway.
// The executor lives in a package now, so the seed comes from the working directory
// (the runner is started with the gateway's cwd) or TP_WALLET_DIR.
function readSeed(): string {
  const p = resolve(walletsDir(), "seed.txt");
  if (!existsSync(p)) throw new Error(`No wallet seed at ${p}. Run: pnpm gen:wallet`);
  return readFileSync(p, "utf8").trim();
}

// Build the page-injection as a PLAIN JS STRING (not a TS function) so the bundler can't
// inject helpers (e.g. esbuild's __name) that would be undefined in the page. Runs before the
// dapp's scripts: an EIP-1193 provider announced via EIP-6963 that reports our address + the
// given chainId and forwards everything else to Node (window.__forkRpc).
function buildInjectSource(address: string, chainIdHex: string): string {
  return `(function(){
  var listeners = {};
  var address = ${JSON.stringify(address)};
  var chainIdHex = ${JSON.stringify(chainIdHex)};
  var rpc = function(m, p){ return window.__forkRpc(m, p || []); };
  var eth = {
    isMetaMask: true,
    _metamask: { isUnlocked: function(){ return Promise.resolve(true); } },
    selectedAddress: address,
    chainId: chainIdHex,
    request: function(a){
      var method = a.method, params = a.params;
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': return Promise.resolve([address]);
        case 'eth_chainId': return Promise.resolve(chainIdHex);
        case 'net_version': return Promise.resolve(String(parseInt(chainIdHex, 16)));
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain': return Promise.resolve(null);
        case 'wallet_requestPermissions':
        case 'wallet_getPermissions': return Promise.resolve([{ parentCapability: 'eth_accounts' }]);
        case 'wallet_getCapabilities': return Promise.resolve({});
        case 'wallet_watchAsset': return Promise.resolve(true);
        default: return rpc(method, params || []);
      }
    },
    on: function(e, cb){ (listeners[e] = listeners[e] || []).push(cb); return this; },
    removeListener: function(e, cb){ listeners[e] = (listeners[e] || []).filter(function(x){ return x !== cb; }); return this; },
    enable: function(){ return Promise.resolve([address]); }
  };
  window.ethereum = eth;
  var info = { uuid: '11111111-1111-1111-1111-111111111111', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', rdns: 'io.metamask' };
  var announce = function(){ window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: info, provider: eth }) })); };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;
}

// Attach an injected virtual wallet to a page: no browser extension, no popups. The provider
// reports `chainId` and proxies signing + reads to `rpcUrl`; the page's own JSON-RPC POSTs are
// also redirected there so a dapp UI that reads chain state via RPC sees the configured chain.
export async function setupInjectedWallet(
  page: Page,
  cfg: ChainConfig,
): Promise<{ address: string; sentTxs: string[]; signatureReceipts: WalletSignatureReceipt[] }> {
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = Wallet.fromPhrase(readSeed()).connect(provider);
  const chainIdHex = "0x" + cfg.chainId.toString(16);
  // Every tx the dapp UI triggers passes through here (we ARE the wallet) — record the hash
  // so the run can assert on the wallet's new on-chain record. No polling/listening needed.
  const sentTxs: string[] = [];
  const signatureReceipts: WalletSignatureReceipt[] = [];
  const signed = async (method: string, promise: Promise<string>) => {
    const origin = new URL(page.url()).origin;
    const signature = await promise;
    signatureReceipts.push({origin,method,at:Date.now()});
    return signature;
  };

  const forkRpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    if (method === "eth_sendTransaction") {
      const t = (params[0] || {}) as {
        to?: string;
        data?: string;
        value?: string;
        gas?: string;
      };
      const sent = await wallet.sendTransaction({
        to: t.to,
        data: t.data,
        value: t.value ? BigInt(t.value) : 0n,
        ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}),
      });
      sentTxs.push(sent.hash);
      return sent.hash;
    }
    // personal_sign/eth_sign messages may be a hex string (bytes) OR a plain UTF-8 string
    // (many dapps pass the latter) — getBytes throws on non-hex, so only decode real hex.
    const asMessage = (m: unknown) =>
      typeof m === "string" && /^0x[0-9a-fA-F]*$/.test(m) ? getBytes(m) : (m as string);
    if (method === "personal_sign") return signed(method, wallet.signMessage(asMessage(params[0])));
    if (method === "eth_sign") return signed(method, wallet.signMessage(asMessage(params[1])));
    if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
      const typed = typeof params[1] === "string" ? JSON.parse(params[1] as string) : (params[1] as Record<string, unknown>);
      const types = { ...(typed.types as Record<string, unknown>) };
      delete (types as Record<string, unknown>).EIP712Domain;
      return signed(method, wallet.signTypedData(typed.domain, types as never, typed.message as never));
    }
    return provider.send(method, params as never[]);
  };

  await page.exposeFunction("__forkRpc", forkRpc);
  await page.evaluateOnNewDocument(buildInjectSource(wallet.address, chainIdHex));

  // Redirect the page's on-chain JSON-RPC reads to the configured chain.
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    try {
      const pd = req.method() === "POST" ? req.postData() : null;
      if (pd && /"method"\s*:\s*"(eth_|net_|web3_|debug_|trace_|erigon_)/.test(pd)) {
        const r = await fetch(cfg.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: pd,
        });
        await req.respond({ status: 200, contentType: "application/json", body: await r.text() });
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      await req.continue();
    } catch {
      /* already handled */
    }
  });

  return { address: wallet.address, sentTxs, signatureReceipts };
}
