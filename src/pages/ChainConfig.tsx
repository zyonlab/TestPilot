import { useCallback, useEffect, useState } from "react";
import {
  Blocks,
  Server,
  Wallet,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Copy,
  Play,
  Puzzle,
  BookOpen,
  Rocket,
  ArrowRight,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { openCard } from "@/lib/open";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

// Quick chain presets — set the RPC + chainId fields with one click.
const PRESETS: { label: string; rpcUrl: string; chainId: number }[] = [
  { label: "Local Anvil / Hardhat", rpcUrl: "http://127.0.0.1:8545", chainId: 31337 },
  { label: "Mainnet fork (chainId 1)", rpcUrl: "http://127.0.0.1:8545", chainId: 1 },
  { label: "Sepolia", rpcUrl: "https://rpc.sepolia.org", chainId: 11155111 },
];

export function ChainConfigPage() {
  const t = useT();
  return (
    <>
      <TopBar title={t("chain.title")} hint={t("chain.subtitle")} />
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-2xl space-y-4">
          <GuideCard />
          <ChainConfigCard />
          <InjectedVerifyCard />
          <MetaMaskCard />
        </div>
      </div>
    </>
  );
}

// How-to guide + one-click Uniswap example. Makes clear TestPilot does NOT deploy the dapp:
// the team brings the dapp URL + a chain RPC (their fork / Tenderly / testnet).
function GuideCard() {
  const t = useT();
  const loadData = useStore((s) => s.loadData);
  const selectProject = useStore((s) => s.selectProject);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [msg, setMsg] = useState("");

  const loadExample = async () => {
    setState("loading");
    setMsg("");
    try {
      const { project, reused } = await api.loadUniswapExample();
      await loadData();
      await selectProject(project.id);
      setMsg(reused ? t("chain.exampleReused") : t("chain.exampleLoaded"));
      openCard("cases");
    } catch (e) {
      setState("error");
      setMsg((e as Error).message);
    }
  };

  const steps = [
    t("chain.guideStep1"),
    t("chain.guideStep2"),
    t("chain.guideStep3"),
    t("chain.guideStep4"),
    t("chain.guideStep5"),
  ];

  return (
    <div className="rounded-xl border border-chat bg-chat-soft p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <BookOpen className="h-4 w-4 text-chat" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("chain.guideTitle")}</h2>
      </div>
      <p className="mb-2 text-xs leading-snug text-muted-foreground">{t("chain.guideIntro")}</p>
      <ol className="mb-2 space-y-1 pl-1 text-xs leading-snug text-foreground">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-chat text-[0.6875rem] font-medium text-primary-foreground">
              {i + 1}
            </span>
            <span className="text-muted-foreground">{s}</span>
          </li>
        ))}
      </ol>
      <p className="mb-3 rounded-md border border-warn bg-warn-soft px-2 py-1.5 text-[0.6875rem] leading-snug text-warn">
        {t("chain.guideNote")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          className="bg-chat text-xs hover:bg-chat"
          onClick={loadExample}
          disabled={state === "loading"}
        >
          {state === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
          {t("chain.loadExample")}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        {msg && (
          <span className={cn("text-[0.6875rem]", state === "error" ? "text-bad" : "text-muted-foreground")}>
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}

// Chain / RPC config + the controllable test wallet.
function ChainConfigCard() {
  const t = useT();
  const [rpcUrl, setRpcUrl] = useState("");
  const [chainId, setChainId] = useState<number>(1);
  const [account, setAccount] = useState("");
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setRpcUrl(c.chain.rpcUrl);
        setChainId(c.chain.chainId);
        setAccount(c.account);
        setState("idle");
      })
      .catch(() => {
        setState("error");
        setDetail(t("model.chainOffline"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setState("saving");
    try {
      const c = await api.saveConfig({ rpcUrl, chainId });
      setRpcUrl(c.chain.rpcUrl);
      setChainId(c.chain.chainId);
      setState("saved");
      setDetail("");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Server className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("model.chainRpc")}</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("model.chainHelp")}</p>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setRpcUrl(p.rpcUrl);
                setChainId(p.chainId);
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-[0.6875rem] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor="rpcUrl" className="mb-1 block text-xs text-muted-foreground">
            {t("model.rpcUrl")}
          </label>
          <input
            id="rpcUrl"
            type="text"
            value={rpcUrl}
            placeholder="http://127.0.0.1:8545"
            onChange={(e) => setRpcUrl(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="chainId" className="mb-1 block text-xs text-muted-foreground">
            {t("model.chainId")}
          </label>
          <input
            id="chainId"
            type="number"
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value))}
            className="w-40 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" onClick={save} disabled={state === "saving" || state === "loading"}>
            {state === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("model.saveChainConfig")}
          </Button>
          {state === "saved" && (
            <span className="flex items-center gap-1.5 text-xs text-ok">
              <CheckCircle className="h-4 w-4" /> {t("model.saved")}
            </span>
          )}
          {state === "error" && (
            <span className="flex items-center gap-1.5 text-xs text-bad">
              <AlertTriangle className="h-4 w-4" /> {detail}
            </span>
          )}
        </div>

        {account && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
            <Wallet className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="text-[0.6875rem] text-muted-foreground">{t("chain.testWallet")}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-foreground">{account}</span>
            <button
              onClick={() => navigator.clipboard?.writeText(account)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Injected virtual wallet — the headless default. Proof: connect + send a REAL tx on the
// configured chain and verify the on-chain receipt (no MetaMask, no model).
function InjectedVerifyCard() {
  const t = useT();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.verifyDapp>> | null>(null);
  const [detail, setDetail] = useState("");

  const run = async () => {
    setState("running");
    setDetail("");
    setRes(null);
    try {
      const r = await api.verifyDapp({});
      setRes(r);
      setState(r.mined ? "done" : "error");
      if (!r.mined) setDetail(r.tx || r.connect || "tx not mined");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Blocks className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("chain.injectedTitle")}</h2>
        <span className="rounded bg-ok-soft px-1.5 text-[0.6875rem] font-medium text-ok">
          {t("chain.default")}
        </span>
      </div>
      <p className="mb-3 text-xs leading-snug text-muted-foreground">{t("chain.injectedHelp")}</p>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          className="bg-chat hover:bg-chat"
          onClick={run}
          disabled={state === "running"}
        >
          {state === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {t("chain.verifyInjected")}
        </Button>
        {state === "running" && (
          <span className="text-xs text-muted-foreground">{t("chain.verifyRunning")}</span>
        )}
        {state === "done" && (
          <span className="flex items-center gap-1.5 text-xs text-ok">
            <CheckCircle className="h-4 w-4" /> {t("chain.verifyOk")}
          </span>
        )}
        {state === "error" && (
          <span className="flex items-center gap-1.5 break-all text-xs text-bad">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" /> {detail}
          </span>
        )}
      </div>

      {res && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <dl className="space-y-1 text-[0.6875rem]">
            <Row k={t("chain.account")} v={res.account} mono />
            <Row k={t("chain.connect")} v={res.connect} mono />
            <Row k={t("chain.tx")} v={res.tx} mono />
            <Row
              k={t("chain.mined")}
              v={res.mined ? `✓ block ${res.block ?? "?"} (status ${res.txStatus ?? "?"})` : "✗"}
            />
          </dl>
          {res.screenshot && (
            <img
              src={res.screenshot}
              alt="dapp"
              className="h-28 w-44 rounded-md border border-border object-cover object-top"
            />
          )}
        </div>
      )}
    </div>
  );
}

// MetaMask extension mode — headed; for flows that require the real wallet UI.
function MetaMaskCard() {
  const t = useT();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.walletCheck>> | null>(null);
  const [detail, setDetail] = useState("");
  const [installed, setInstalled] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = await api.getHealth();
      setInstalled(h.walletInstalled);
    } catch {
      setInstalled(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async () => {
    setState("running");
    setDetail("");
    setRes(null);
    try {
      const r = await api.walletCheck();
      setRes(r);
      setState(r.loaded ? "done" : "error");
      if (!r.loaded) setDetail(r.detail || r.error || "not loaded");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Puzzle className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">{t("chain.metamaskTitle")}</h2>
        {installed === false && (
          <span className="rounded bg-warn-soft px-1.5 text-[0.6875rem] font-medium text-warn">
            {t("chain.notInstalled")}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs leading-snug text-muted-foreground">{t("chain.metamaskHelp")}</p>

      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={state === "running" || installed === false}>
          {state === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Puzzle className="h-3.5 w-3.5" />
          )}
          {t("chain.checkMetamask")}
        </Button>
        {state === "done" && res && (
          <span className="flex items-center gap-1.5 text-xs text-ok">
            <CheckCircle className="h-4 w-4" /> {t("chain.loaded")} · onboarded={String(res.onboarded)} ·
            unlocked={String(res.unlocked)}
          </span>
        )}
        {state === "error" && (
          <span className="flex items-center gap-1.5 text-xs text-bad">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" /> {detail}
          </span>
        )}
      </div>
      {res?.screenshot && (
        <img
          src={res.screenshot}
          alt="wallet"
          className="mt-3 h-40 w-64 rounded-md border border-border object-contain"
        />
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v?: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 flex-shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn("min-w-0 flex-1 break-all text-foreground", mono && "font-mono")}>{v || "—"}</dd>
    </div>
  );
}
