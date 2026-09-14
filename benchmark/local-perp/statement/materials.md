# Local Perp Lab v1 — controlled product contract

This is a local demonstration, not an exchange API specification. The product is a BTC-USDC perpetual-futures order panel. A fresh independent case must POST `${env.LAB_URL}/api/reset` before interacting. Default: no position, no orders, leverage 20, available balance 1000 USDC, reference price 80000 USDC/BTC. Base quantity unit BTC, quote unit USDC. All monetary values returned by the API are decimal strings. No real funds or external accounts.

## Size normalization
The Size field is in BTC. This product explicitly truncates positive inputs to step 0.001, never rounds up. A resulting quantity below 0.001 is rejected. A market order uses that normalized quantity. The “Place Order” button submits it. Market is the default selected tab. “Close Position” removes the position.

## Leverage
The Leverage field and “Set Leverage” button accept integers 1 through 40 inclusive. An invalid value is rejected and the prior leverage remains unchanged. This fixture has one leverage tier; dynamic notional tiers are out of scope.

## Limit price
“Limit” selects a limit order. Price is in USDC and must be positive and aligned to tick 0.5. An aligned price at either inclusive boundary, 16000 or 144000, is accepted. Outside that band the order is rejected. This 80% band is the local contract, not a claim about every venue. “Cancel All” removes all orders.

## Margin
For market orders, size BTC × fixed 80000 USDC/BTC / leverage must not exceed balance 1000 USDC. Exact equality is accepted. An order above available margin is rejected and the position stays unchanged. Fees and funding are absent from this controlled contract.

## Observation API
GET `${env.LAB_URL}/api/clearinghouse` returns `position` (null, or `{coin:"BTC",szi:"0.001",leverage:20}`), `orders` (array `{oid,coin,limitPx,sz}`), `leverage`, `balance`, `unit:"BTC"`, `quoteUnit:"USDC"`, `lastError` (null or refusal text), `version:"perp-lab-v1"`, `observedAt` ISO timestamp. Use machine API predicates with decimal values, unique coin selection and reset preconditions. A missing/ambiguous observation is unobservable.

Source anchors are these section headings. This statement does not contain review labels, mutation identities or held-out answers. The design model receives only this contract and the selected optional domain reference.
