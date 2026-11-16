# API Reference

Complete reference for all public classes, methods, and types exported by
`@stellarbuild/stellar-flow`.

---

## Exports

```typescript
import {
  TxBuilder,
  ScVal,

  // Types (import with `import type` where possible)
  TxBuilderOptions,
  PaymentParams,
  CreateAccountParams,
  ChangeTrustParams,
  ManageOfferParams,
  ManageBuyOfferParams,
  PathPaymentParams,
  SetOptionsParams,
  ManageDataParams,
  InvokeContractParams,
  TimeboundParams,
  BuiltTransaction,
  SubmitResult,
  NetworkPassphrase,
} from '@stellarbuild/stellar-flow';
```

---

## `TxBuilder`

The primary class. Use the static `for()` factory to create an instance.

### `TxBuilder.for(keypair, options)`

**Creates a new builder for the given source account keypair and network.**

```typescript
static for(keypair: Keypair, options: TxBuilderOptions): TxBuilder
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `keypair` | `Keypair` | ✅ | Source account keypair (from `@stellar/stellar-sdk`) |
| `options` | `TxBuilderOptions` | ✅ | Network and builder configuration |

**Example:**
```typescript
import { Keypair } from '@stellar/stellar-sdk';
import { TxBuilder } from '@stellarbuild/stellar-flow';

const keypair = Keypair.fromSecret('S...');
const builder = TxBuilder.for(keypair, { network: 'testnet' });
```

---

### `TxBuilderOptions`

```typescript
interface TxBuilderOptions {
  network: 'mainnet' | 'testnet' | 'futurenet';
  fee?: string;        // base fee in stroops (default: '100')
  horizonUrl?: string; // override default Horizon endpoint
  sorobanUrl?: string; // required when using invokeContract()
  timeout?: number;    // request timeout in ms (reserved for future use)
}
```

| Field | Default | Description |
|---|---|---|
| `network` | — | Target network. Determines Horizon URL and passphrase. |
| `fee` | `'100'` | Base fee per operation in stroops (1 XLM = 10,000,000 stroops) |
| `horizonUrl` | Auto | Override the Horizon URL. Useful for private Horizon instances. |
| `sorobanUrl` | — | Soroban RPC URL. **Required** when using `invokeContract()`. |
| `timeout` | — | Reserved — not yet applied |

---

### `TxBuilder.fromXDR(xdrString, options)`

**Reconstructs an editable `TxBuilder` from an existing base64-encoded XDR transaction envelope.**

> [!IMPORTANT]
> **Intended Use Case:** Use `TxBuilder.fromXDR()` when you need to inspect, modify, or append operations to an existing transaction template.
> Rebuilding (`.build()`) queries Horizon for a fresh account sequence number, creates a new transaction envelope, and re-simulates Soroban resource fees and footprint. **Rebuilding creates a new transaction and does NOT preserve pre-existing envelope signatures or original Soroban transaction metadata (`ext.sorobanData()`).**
> If you need to preserve existing signatures and co-sign an envelope without re-fetching sequences or rebuilding the transaction, use `BuiltTransaction.fromXDR()` instead.

```typescript
static fromXDR(xdrString: string, options: TxBuilderOptions): TxBuilder
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `xdrString` | `string` | ✅ | Base64-encoded Stellar transaction envelope (`TransactionEnvelope`) |
| `options` | `TxBuilderOptions` | ✅ | Builder options (`network` is required) |

#### Reconstructed State:
- **Source Account:** Restores a public-only keypair (`Keypair.fromPublicKey(tx.source)`) matching the envelope's source account.
- **Base Fee:** If `options.fee` is omitted, the base fee is calculated from the transaction total fee divided by the number of operations (`Math.floor(parseInt(tx.fee) / numOps)`). If `options.fee` is explicitly provided, it overrides the XDR base fee.
- **Memo & Timebounds:** Preserves text memos (and non-text raw memos) as well as `minTime` / `maxTime` timebounds.
- **Operations:** Restores all supported operation types, along with their parameters:
  - Preserves operation-level `sourceAccount` on every operation where specified.
  - Preserves `LiquidityPoolAsset` trustlines on `changeTrust`.
  - Preserves Soroban `auth` authorization entries on `invokeContract`.

#### Limitations:
- **Signatures are not preserved:** `fromXDR()` reconstructs an unsigned builder. Calling `.build()` produces an unsigned envelope that must be signed using `.sign(keypair)` before submission.
  > [!TIP]
  > If you need to preserve existing signatures and co-sign an envelope without re-fetching sequences or rebuilding the transaction, use `BuiltTransaction.fromXDR()` instead. See [BuiltTransaction.fromXDR()](#builttransactionfromxdrxdrstring-options).
- **Public-only Source Keypair:** The restored builder holds a public keypair without secret keys. Supply secret keypairs when calling `.sign()` on the built transaction.
- **Fee-Bump Envelopes:** Fee-bump envelopes (`txFeeBump`) are not supported and throw `TxBuilderValidationError`.
- **Unsupported Operations:** Envelopes containing operations not currently supported by Stellar Flow (such as `accountMerge`) throw `TxBuilderValidationError`.
- **Host Functions:** For Soroban, only contract invocations (`hostFunctionTypeInvokeContract`) are supported; contract creation host functions throw `TxBuilderValidationError`.

**Example:**
```typescript
import { Keypair } from '@stellar/stellar-sdk';
import { TxBuilder } from '@stellarbuild/stellar-flow';

// Reconstruct builder from existing envelope
const restored = TxBuilder.fromXDR(envelopeXdr, { network: 'testnet' });

// Inspect the restored operations and metadata
const description = restored.describe();
console.log('Restored operations:', description.operations);

// Build, sign with signing keypair, and submit
const built = await restored.build();
built.sign(signingKeypair);
await built.submit();
```

---

## Operation Methods

All operation methods are **synchronous** and **return `this`** for chaining.
Input validation is performed immediately — errors are thrown before any network
call.

### Operation-Level Source Accounts

All operation parameter interfaces accept an optional `sourceAccount?: string` (a valid Stellar public key starting with `'G'`).

- **Distinct from Transaction Source:** If provided, the specific operation executes on behalf of `sourceAccount`, rather than the transaction's overall source account (`TxBuilder.for(keypair)`).
- **Default Behavior:** When omitted, the operation executes under the transaction's source account.
- **Immediate Validation:** If supplied, `sourceAccount` is validated synchronously. An invalid public key throws `TxBuilderValidationError` immediately without modifying the builder's operations or descriptors.

---

### `.addPayment(params)`

Adds a payment operation to send XLM or a custom asset to a destination account.

```typescript
addPayment(params: PaymentParams): this
```

**`PaymentParams`:**

```typescript
interface PaymentParams {
  destination: string;                                    // Stellar public key (G...)
  amount: string;                                         // Amount to send (e.g. '100')
  asset: 'XLM' | { code: string; issuer: string };       // Asset to send
  memo?: string;                                          // Optional text memo (max 28 bytes)
  sourceAccount?: string;                                 // Optional operation-level source account (G...)
}
```

**Throws:**
- `destination` is not a valid Stellar public key
- `amount` is not a positive number string
- Asset `code` or `issuer` is empty

**Example:**
```typescript
builder
  .addPayment({ destination: 'G...', amount: '10', asset: 'XLM' })
  .addPayment({
    destination: 'G...',
    amount: '50',
    asset: { code: 'USDC', issuer: 'GA5ZSEJ...' },
    memo: 'Invoice #42',
  });
```

---

### `.addCreateAccount(params)`

Creates a new Stellar account by funding it with an initial XLM balance.

```typescript
addCreateAccount(params: CreateAccountParams): this
```

**`CreateAccountParams`:**

```typescript
interface CreateAccountParams {
  destination: string;    // New account public key (G...)
  startingBalance: string;// Initial XLM balance (minimum: '1')
  sourceAccount?: string; // Optional operation-level source account (G...)
}
```

**Throws:**
- `destination` is not a valid Stellar public key
- `startingBalance` is not a positive number string

---

### `.addChangeTrust(params)`

Adds or modifies a trustline for an issued asset or AMM liquidity pool.
Pass `limit: '0'` to remove the trustline.

```typescript
addChangeTrust(params: ChangeTrustParams): this
```

**`ChangeTrustParams`:**

```typescript
interface ChangeTrustParams {
  asset: { code: string; issuer: string } | LiquidityPoolAsset; // Asset or liquidity pool to trust
  limit?: string;         // Trust limit. Omit for max; '0' to remove
  sourceAccount?: string; // Optional operation-level source account (G...)
}
```

**Supported Asset Inputs:**
- **Credit Asset:** `{ code: string; issuer: string }`
- **Liquidity Pool:** `LiquidityPoolAsset` instance imported from `@stellar/stellar-sdk`

**Example:**
```typescript
import { Keypair, Asset, LiquidityPoolAsset, LiquidityPoolFeeV18 } from '@stellar/stellar-sdk';
import { TxBuilder } from '@stellarbuild/stellar-flow';

// Standard credit asset trustline
builder.addChangeTrust({
  asset: { code: 'USDC', issuer: 'GA5ZSEJ...' },
  limit: '1000',
});

// Liquidity pool trustline
const lpAsset = new LiquidityPoolAsset(
  Asset.native(),
  new Asset('USDC', 'GA5ZSEJ...'),
  LiquidityPoolFeeV18,
);

builder.addChangeTrust({
  asset: lpAsset,
  limit: '5000',
});
```

---

### `.addManageOffer(params)`

Places or updates a sell offer on the Stellar DEX.

```typescript
addManageOffer(params: ManageOfferParams): this
```

**`ManageOfferParams`:**

```typescript
interface ManageOfferParams {
  selling: { code: string; issuer: string } | 'XLM';
  buying:  { code: string; issuer: string } | 'XLM';
  amount:  string;                             // Amount of 'selling' asset to sell
  price:   string | { n: number; d: number }; // Price in terms of buying/selling
  offerId?: string;                            // '0' creates a new offer (default); existing ID modifies it
  sourceAccount?: string;                      // Optional operation-level source account (G...)
}
```

**Throws:**
- `amount` is not a positive number string
- `price` is not a valid positive decimal or `{ n, d }` fraction
- Asset code or issuer is empty

---

### `.addManageBuyOffer(params)`

Places or updates a buy offer on the Stellar DEX.

```typescript
addManageBuyOffer(params: ManageBuyOfferParams): this
```

**`ManageBuyOfferParams`:**

```typescript
interface ManageBuyOfferParams {
  selling: { code: string; issuer: string } | 'XLM';
  buying:  { code: string; issuer: string } | 'XLM';
  amount:  string;                             // Amount of 'buying' asset to buy
  price:   string | { n: number; d: number }; // Price in terms of selling/buying
  offerId?: string;
  sourceAccount?: string;                      // Optional operation-level source account (G...)
}
```

---

### `.addPathPayment(params)`

Adds a path payment strict-send operation — sends an exact amount of one asset
and receives at least a minimum amount of another, traversing the DEX order
books along an asset path.

```typescript
addPathPayment(params: PathPaymentParams): this
```

**`PathPaymentParams`:**

```typescript
interface PathPaymentParams {
  destination: string;
  sendAsset:   { code: string; issuer: string } | 'XLM';
  sendAmount:  string;  // Exact amount to send
  destAsset:   { code: string; issuer: string } | 'XLM';
  destAmount:  string;  // Minimum amount to receive (slippage floor)
  path?: ({ code: string; issuer: string } | 'XLM')[]; // Intermediate assets
  sourceAccount?: string; // Optional operation-level source account (G...)
}
```

---

### `.addSetOptions(params)`

Sets account options such as signers, thresholds, flags, and home domain.
All fields are optional — only supplied fields are modified.

```typescript
addSetOptions(params: SetOptionsParams): this
```

**`SetOptionsParams`:**

```typescript
interface SetOptionsParams {
  inflationDest?: string;   // Stellar public key
  clearFlags?: number;      // Bitmask of flags to clear
  setFlags?: number;        // Bitmask of flags to set
  masterWeight?: number;    // 0–255
  lowThreshold?: number;    // 0–255
  medThreshold?: number;    // 0–255
  highThreshold?: number;   // 0–255
  homeDomain?: string;      // Max 32 characters
  signer?: {
    ed25519PublicKey?: string; // Stellar public key signer
    sha256Hash?: string;       // 64-hex-char SHA256 hash
    preAuthTx?: string;        // 64-hex-char pre-auth transaction hash
    weight: number;            // 0–255 (0 removes the signer)
  };
  sourceAccount?: string;   // Optional operation-level source account (G...)
}
```

**Throws:**
- `inflationDest` is not a valid Stellar address
- Any threshold or weight is outside the 0–255 range
- `homeDomain` exceeds 32 characters
- `signer` is specified without a type (`ed25519PublicKey`, `sha256Hash`, or `preAuthTx`)
- `sha256Hash` or `preAuthTx` is not exactly 64 hex characters

---

### `.addManageData(params)`

Stores or removes a key-value data entry on the source account.

```typescript
addManageData(params: ManageDataParams): this
```

**`ManageDataParams`:**

```typescript
interface ManageDataParams {
  name: string;           // UTF-8 key, max 64 bytes
  value?: string | null;  // UTF-8 value, max 64 bytes (optional)
  sourceAccount?: string; // Optional operation-level source account (G...)
}
```

- `value` is optional and accepts `string | null`.
- `null` or omission deletes the entry.
- `''` stores an empty value; it does not delete the entry.

**Throws:**
- `name` is empty or exceeds 64 bytes
- `value` exceeds 64 bytes
- `value` is not a string or null

---

### `.invokeContract(params)`

Constructs a Soroban contract invocation using `Operation.invokeHostFunction`. Automatically converts basic JavaScript types and allows native `xdr.ScVal` arguments for complex inputs.

```typescript
invokeContract(params: InvokeContractParams): this
```

**`InvokeContractParams`:**

```typescript
interface InvokeContractParams {
  contractId: string;   // Stellar contract address (C...)
  functionName: string; // Exported contract function name
  args?: (
    | string
    | number
    | boolean
    | { address: string }
    | { amount: string; asset: { code: string; issuer: string } | 'XLM' }
    | xdr.ScVal
  )[];
  auth?: xdr.SorobanAuthorizationEntry[];
  sourceAccount?: string; // Optional operation-level source account (G...)
}
```

*Note: For complex argument types, use the exported `ScVal` helpers from `stellar-flow` (`ScVal.u32()`, `ScVal.u64()`, `ScVal.Address()`, `ScVal.Vec()`, etc.) to construct typed `xdr.ScVal` inputs without importing SDK internals directly.*

*Authorization (`auth`):*
- `auth` is optional and defaults to an empty array (`[]`).
- It accepts Soroban authorization entries (`xdr.SorobanAuthorizationEntry[]`), including entries obtained through a Soroban simulation/authorization workflow (e.g., via Soroban RPC `simulateTransaction`).
- These are operation-level authorization entries representing contract invocations and call authorizations, not transaction-envelope signatures.
- Stellar Flow preserves supplied entries; it does not automatically generate or sign them.

```typescript
import { TxBuilder, ScVal } from '@stellarbuild/stellar-flow';

const tx = await TxBuilder.for(keypair, {
  network: 'testnet',
  sorobanUrl: 'https://soroban-testnet.stellar.org',
})
  .invokeContract({
    contractId: 'CCLZ...',
    functionName: 'transfer',
    args: [ScVal.Address(senderAddress), ScVal.Address(receiverAddress), ScVal.i128(1000n)],
  })
  .build();
```

---

### `.wrapInFeeBump(feeSource, fee?)` *(Deprecated)*

> [!WARNING]
> `TxBuilder.prototype.wrapInFeeBump()` is **deprecated**. Fee-bump wrapping is performed on a signed built transaction (`tx.wrapInFeeBump(...)`), not during builder configuration.
>
> To create a fee-bump transaction:
> ```typescript
> const tx = await builder.build();
> tx.sign(sourceKeypair);
> const feeBump = tx.wrapInFeeBump({ feeSource: sponsorKeypair, baseFee: '200' });
> feeBump.sign(sponsorKeypair);
> await feeBump.submit();
> ```
> Calling `builder.wrapInFeeBump()` will always throw synchronously with instructions.

```typescript
wrapInFeeBump(feeSource: string, fee?: string): this
// Always throws: 'TxBuilder.wrapInFeeBump() is deprecated and not supported.
//                Fee-bump wrapping must be performed on a signed built transaction...'
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `feeSource` | `string` | — | *(ignored — method throws before use)* |
| `fee` | `string` | — | *(ignored — method throws before use)* |

---

## Transaction Metadata Methods

### `.setMemo(text)`

Sets a text memo on the transaction.

```typescript
setMemo(text: string): this
```

| Parameter | Constraint |
|---|---|
| `text` | Non-empty string, maximum **28 UTF-8 bytes** |

**Note:** If `addPayment()` is called with a `memo` field, `setMemo()` called
afterwards will override it.

---

### `.setTimebounds(bounds)`

Sets the validity window for the transaction.

```typescript
setTimebounds(bounds: TimeboundParams): this
```

**`TimeboundParams`:**

```typescript
interface TimeboundParams {
  minTime?: string | number; // Earliest valid time
  maxTime?: string | number; // Latest valid time (expiry)
}
```

Accepted value formats:
| Format | Example | Notes |
|---|---|---|
| Relative string | `'+5m'`, `'+1h'`, `'+2d'`, `'+30s'` | Relative to current time |
| Unix timestamp | `1800000000` | Seconds since epoch |
| ISO 8601 string | `'2025-12-31T23:59:59Z'` | Parsed via `new Date()` |
| `0` | `0` | No bound (only valid for `minTime`) |

If `setTimebounds()` is not called, the transaction uses `TimeoutInfinite`
(no expiry).

---

## Build & Submit

### `.build()`

Loads the source account from Horizon and assembles the transaction.

```typescript
async build(): Promise<InspectableBuiltTransaction>
```

**Throws:**
- If no operations have been added: `'Cannot build a transaction with no operations'`
- If Horizon is unreachable: network error from SDK

---

## `BuiltTransaction` and `InspectableBuiltTransaction`

### `BuiltTransaction`

The base interface representing a built Stellar transaction ready for signing and submission. All transactions created by Stellar Flow satisfy this contract.

```typescript
interface BuiltTransaction {
  xdr: string;                             // Current base64 XDR (updated after sign())
  sign(keypair: Keypair): BuiltTransaction; // Sign and return this for chaining
  toXDR(): string;                         // Return current XDR string
  submit(): Promise<SubmitResult>;         // Submit to Horizon
}
```

### `InspectableBuiltTransaction`

A richer extension of `BuiltTransaction` returned by `TxBuilder.prototype.build()` and `BuiltTransaction.fromXDR()`. Exposes cryptographic transaction hash calculation, envelope signature inspection, and post-build fee-bump wrapping while maintaining full backwards compatibility with `BuiltTransaction`.

```typescript
interface InspectableBuiltTransaction extends BuiltTransaction {
  sign(keypair: Keypair): InspectableBuiltTransaction;
  hash(): string;
  readonly signatures: readonly {
    readonly hint: string;
    readonly signature: string;
  }[];
  wrapInFeeBump(options: FeeBumpOptions): FeeBumpBuiltTransaction;
}
```

### Methods & Properties

- **`hash(): string`**: Returns the 64-character hexadecimal transaction hash (`tx.hash().toString('hex')`). This hash is cryptographically computed over the transaction payload (network ID + transaction body) and is completely immutable when adding signatures.
- **`signatures: readonly { readonly hint: string; readonly signature: string }[]`**: A read-only list of decorated signatures currently present on the envelope. Each entry contains:
  - `hint`: 8-character hexadecimal string representing the 4-byte signature hint.
  - `signature`: 128-character hexadecimal string representing the 64-byte Ed25519 signature.
- **`wrapInFeeBump(options: FeeBumpOptions): FeeBumpBuiltTransaction`**: Wraps the signed inner transaction in a CAP-0015 fee-bump envelope.
  - **Pre-signing Requirement:** The inner transaction must contain at least one envelope signature before wrapping.
  - **Threshold Note:** Having $\ge 1$ signature does not establish that the inner transaction has satisfied all required signing thresholds (e.g. multisig). Complete authorization is verified at ledger consensus time. All required inner signers should sign before wrapping.
  - **Immutability:** Wrapping does not mutate the inner transaction.
- **`sign(keypair: Keypair): InspectableBuiltTransaction`**: Appends the keypair's signature to the transaction envelope and synchronizes `xdr`.
  - **Duplicate Prevention:** Before adding a signature, checks whether `keypair` has already signed the transaction using cryptographic verification (`keypair.verify(tx.hash(), sig.signature())`). If already signed, the call is a safe, idempotent no-op and returns `this`.
  - **20-Signature Limit:** Stellar limits transaction envelopes to a maximum of 20 signatures. If an envelope already contains 20 signatures from other signers, attempting to sign with a 21st distinct keypair throws `TxBuilderValidationError` without mutating the transaction state. Re-signing with an existing signer on a 20-signature envelope remains an idempotent no-op.
- **`toXDR(): string`**: Returns the base64-encoded XDR transaction envelope string.
- **`submit(): Promise<SubmitResult>`**: Submits the transaction to Horizon via the configured Horizon server.

---

### `BuiltTransaction.fromXDR(xdrString, options)`

**Restores an existing transaction envelope directly from base64 XDR without modifying sequence numbers or discarding existing signatures and Soroban metadata.**

> [!IMPORTANT]
> **Intended Use Case:** Use `BuiltTransaction.fromXDR()` for multi-party co-signing, air-gapped signing pipelines, signature collection, and direct envelope submission.
> Unlike `TxBuilder.fromXDR()`, which rebuilds a transaction and resets sequence numbers/signatures, `BuiltTransaction.fromXDR()` restores the exact `Transaction` envelope in memory without querying Horizon. It preserves all pre-existing signatures, account sequence numbers, and Soroban metadata (`ext.sorobanData()`, resource fees, footprint keys, and `auth` entries) byte-for-byte.

- **Preserves all signatures:** Retains every signature already attached to the envelope.
- **Preserves sequence number:** Does not query Horizon to re-fetch or increment account sequence numbers.
- **Preserves Soroban footprint & auth:** Retains any Soroban transaction data (`ext.sorobanData()`), resource fees, and operation-level authorization entries (`auth`).
- **Preserves metadata:** Retains transaction source, sequence, fee, timebounds, memo, operations, and custom operation-level source accounts.

```typescript
static fromXDR(xdrString: string, options: TxBuilderOptions): InspectableBuiltTransaction
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `xdrString` | `string` | ✅ | Base64-encoded Stellar transaction envelope (`TransactionEnvelope`) |
| `options` | `TxBuilderOptions` | ✅ | Builder options (`network` is required, `horizonUrl` optional) |

#### Validation & Error Handling:
- Throws `TxBuilderValidationError` if `xdrString` is empty or not a valid base64 XDR transaction envelope.
- Throws `TxBuilderValidationError` if `options.network` is unrecognized.
- Throws `TxBuilderValidationError` if `xdrString` is a fee-bump envelope (`envelopeTypeTxFeeBump`), directing consumers to `FeeBumpBuiltTransaction.fromXDR()`.

#### Multi-Signature Co-Signing Workflow Example:

```typescript
import { Keypair } from '@stellar/stellar-sdk';
import { BuiltTransaction } from '@stellarbuild/stellar-flow';

// Party A constructs and signs a multi-sig transaction
// (e.g., via TxBuilder or external tool) and exports base64 XDR
const partyAXdr = 'AAAA...';

// Party B loads the envelope without rebuilding or querying Horizon
const envelope = BuiltTransaction.fromXDR(partyAXdr, { network: 'testnet' });

// Inspect the envelope
console.log('Transaction hash:', envelope.hash());
console.log('Existing signatures count:', envelope.signatures.length);
console.log('First signer hint:', envelope.signatures[0].hint);

// Party B adds their signature
envelope.sign(partyBKeypair);

// Re-signing with partyBKeypair is safe and idempotent (no duplicates added)
envelope.sign(partyBKeypair);
console.log('Total signatures count:', envelope.signatures.length); // 2

// Submit the fully signed envelope to Horizon
const result = await envelope.submit();
console.log('Submission hash:', result.hash);
console.log('Included in ledger:', result.ledger);
```

---

## Fee-Bump Transactions (CAP-0015)

Stellar CAP-0015 defines fee-bump transactions, allowing a sponsor account (`feeSource`) to pay transaction fees on behalf of an inner transaction.

### Core Architecture & Concepts

- **What Fee-Bumping Does:** Encapsulates a valid inner transaction inside an outer fee-bump envelope. The network executes the inner operations under the inner source account's sequence number and authority, while deducting the transaction fee exclusively from the outer `feeSource` account.
- **Who Pays the Fee:** The outer `feeSource` account pays the entire outer fee ($baseFee \times (innerOps + 1) + resourceFee$). The inner account pays 0 stroops.
- **Why Inner Signing Happens Before Wrapping:** Under CAP-0015, the outer transaction hash ($H_{\text{outer}}$) is computed over the inner transaction envelope *including all of its signatures*. Adding an inner signature after wrapping mutates the inner envelope and cryptographically invalidates all outer fee-source signatures. Inner signing must be completed before fee-bump wrapping.
- **Inner vs. Outer Signatures:**
  - `innerSignatures`: Signatures attached by the inner source account or operation source accounts authorizing the transaction's operations.
  - `signatures`: Signatures attached to the outer fee-bump envelope authorizing fee deduction from `feeSource`.
- **Inner vs. Outer Hashes:**
  - `innerHash()`: Cryptographic hash of the inner transaction payload.
  - `hash()`: Cryptographic hash of the outer fee-bump transaction payload. Outer signatures are verified against `hash()`.
- **`baseFee` Rate Semantics:** `baseFee` represents the inclusion fee rate in stroops per operation ($\ge 100$ and $\ge innerInclusionRate$). Total outer fee is computed as:
  $$\text{outerFee} = baseFee \times (innerOps + 1) + resourceFee$$
  The additional operation accounts for the fee-bump wrapper itself.
- **Default Fee Calculation:** When `baseFee` is omitted, Stellar Flow calculates the minimum legal fee rate using exact BigInt integer ceiling division:
  $$\text{defaultBaseFee} = \max(100, \lceil innerInclusionRate \rceil)$$
- **Soroban Resource Fees:** For Soroban transactions, resource fees are paid by the outer fee sponsor in addition to regular inclusion fees. Soroban resource fees are automatically extracted and subtracted when validating the per-operation inclusion fee rate, and added to the total outer fee.
- **Signing Thresholds Distinction:** Stellar Flow enforces that an inner transaction has at least one signature before wrapping. However, having one or more signatures does **not** establish that all account thresholds or operation-level source thresholds have been satisfied. Authorization is determined by Stellar network consensus.

---

### `FeeBumpOptions`

Options passed to `tx.wrapInFeeBump()`:

```typescript
interface FeeBumpOptions {
  /**
   * Account paying the transaction fee. Can be an Ed25519 public key (G...),
   * a muxed account (M...), or a Keypair instance.
   */
  feeSource: string | Keypair;

  /**
   * Inclusion fee rate in stroops per operation.
   * If omitted, defaults to max(100, ceil(innerInclusionFeeRate)).
   */
  baseFee?: string | number;
}
```

---

### `FeeBumpBuiltTransaction`

The interface representing a fee-bump transaction ready for outer signing and submission. Extends `BuiltTransaction` (the original 4-member contract) rather than `InspectableBuiltTransaction`, preventing nested fee-bump wrapping.

```typescript
interface FeeBumpBuiltTransaction extends BuiltTransaction {
  /** Signs the outer fee-bump envelope with the fee-source keypair */
  sign(keypair: Keypair): FeeBumpBuiltTransaction;

  /** Fee source account address (G... or M...) */
  readonly feeSource: string;

  /** Total outer fee in stroops (string representation of int64) */
  readonly fee: string;

  /** Cryptographic hash of the outer fee-bump transaction */
  hash(): string;

  /** Cryptographic hash of the inner transaction */
  innerHash(): string;

  /** Signatures on the outer fee-bump envelope */
  readonly signatures: readonly {
    readonly hint: string;
    readonly signature: string;
  }[];

  /** Signatures on the inner transaction envelope */
  readonly innerSignatures: readonly {
    readonly hint: string;
    readonly signature: string;
  }[];

  /** Source account of the inner transaction */
  readonly innerSource: string;

  /** Serializes only the inner transaction envelope to base64 XDR */
  innerToXDR(): string;
}
```

#### Properties & Methods:
- **`sign(keypair: Keypair): FeeBumpBuiltTransaction`**: Signs the outer fee-bump envelope with `keypair`.
  - **Outer Hash Verification:** Verified cryptographically against `this.hash()`.
  - **Duplicate Prevention:** Safe, idempotent no-op if `keypair` has already signed outer envelope.
  - **Independent 20-Signature Limit:** Outer envelope supports up to 20 signatures independently of the inner envelope's 20-signature limit.
  - **Hash & Inner Stability:** Does not modify `this.hash()`, `this.innerHash()`, or `this.innerSignatures`.
- **`feeSource: string`**: Public key string (G... or M...) of the fee sponsor.
- **`fee: string`**: Total outer fee in stroops as a decimal string.
- **`hash(): string`**: 64-character hex hash of the outer fee-bump transaction.
- **`innerHash(): string`**: 64-character hex hash of the inner transaction.
- **`signatures`**: Deeply readonly list of outer signatures.
- **`innerSignatures`**: Deeply readonly list of inner signatures.
- **`innerSource: string`**: Source account of the inner transaction.
- **`innerToXDR(): string`**: Returns the inner transaction's base64-encoded XDR envelope.
- **`toXDR(): string`**: Returns the outer fee-bump base64-encoded XDR envelope.
- **`submit(): Promise<SubmitResult>`**: Submits the complete outer fee-bump envelope to Horizon.

---

### `FeeBumpBuiltTransaction.fromXDR(xdrString, options?)`

Restores an existing fee-bump transaction envelope directly from base64 XDR without modifying sequence numbers or discarding signatures and Soroban metadata.

```typescript
static fromXDR(
  xdrString: string,
  options?: FeeBumpFromXDROptions
): FeeBumpBuiltTransaction
```

`FeeBumpFromXDROptions`:
```typescript
interface FeeBumpFromXDROptions {
  network?: 'mainnet' | 'testnet' | 'futurenet';
  networkPassphrase?: string;
  horizonUrl?: string;
}
```

#### Validation & Error Handling:
- Throws `TxBuilderValidationError` if `xdrString` is empty or malformed.
- Throws `TxBuilderValidationError` if `xdrString` is an ordinary transaction envelope (`envelopeTypeTx`), directing users to `BuiltTransaction.fromXDR()`.
- Throws `TxBuilderValidationError` if neither `network` nor `networkPassphrase` is provided.
- Throws `TxBuilderValidationError` if `networkPassphrase` is a custom/unrecognized passphrase and neither `network` nor `horizonUrl` is provided.

#### Horizon URL Resolution:
1. An explicitly supplied `options.horizonUrl` always takes precedence.
2. An explicitly supplied `options.network` determines the default Horizon URL (`mainnet`, `testnet`, `futurenet`).
3. If `network` is omitted but `networkPassphrase` matches a recognized Stellar network (`Networks.PUBLIC`, `Networks.TESTNET`, `Networks.FUTURENET`), its corresponding Horizon endpoint is inferred (in particular, `Networks.PUBLIC` resolves to `https://horizon.stellar.org`).
4. Custom or unrecognized network passphrases require an explicit `horizonUrl` (or `network`).

---

### Complete Fee-Bump Workflow Example

```typescript
import { Keypair } from '@stellar/stellar-sdk';
import { TxBuilder, FeeBumpBuiltTransaction } from '@stellarbuild/stellar-flow';

// 1. User builds inner transaction
const userKeypair = Keypair.random();
const sponsorKeypair = Keypair.random();

const tx = await TxBuilder.for(userKeypair, { network: 'testnet' })
  .addPayment({
    destination: 'GD...',
    asset: 'XLM',
    amount: '25',
  })
  .build();

// 2. User signs inner transaction first
tx.sign(userKeypair);

// 3. Sponsor wraps the signed inner transaction
const feeBump = tx.wrapInFeeBump({
  feeSource: sponsorKeypair,
  baseFee: '200',
});

// 4. Sponsor signs outer fee-bump envelope
feeBump.sign(sponsorKeypair);

// 5. Submit outer fee-bump envelope to Horizon
const result = await feeBump.submit();
console.log('Submission hash:', result.hash);

// 6. Alternatively, export and restore via FeeBumpBuiltTransaction.fromXDR()
const exportedXdr = feeBump.toXDR();
const restored = FeeBumpBuiltTransaction.fromXDR(exportedXdr, { network: 'testnet' });
console.log('Restored feeSource:', restored.feeSource);
console.log('Restored fee:', restored.fee);
```

---

## `SubmitResult`

Returned by `submit()`.

```typescript
interface SubmitResult {
  hash:       string;  // Transaction hash
  ledger:     number;  // Ledger number in which the transaction was included
  successful: boolean; // Whether the transaction was applied successfully
  resultXdr:  string;  // Base64-encoded XDR result envelope
}
```
