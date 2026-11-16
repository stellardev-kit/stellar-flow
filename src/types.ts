import type { Keypair, LiquidityPoolAsset, Networks, xdr } from '@stellar/stellar-sdk';

/**
 * Supported Stellar network passphrases
 */
export type NetworkPassphrase =
  typeof Networks.PUBLIC | typeof Networks.TESTNET | typeof Networks.FUTURENET;

/**
 * Configuration options for TxBuilder
 */
export interface TxBuilderOptions {
  network: 'mainnet' | 'testnet' | 'futurenet';
  fee?: string; // base fee in stroops, default '100'
  horizonUrl?: string; // override default Horizon endpoint
  sorobanUrl?: string; // required for Soroban contract invocations
  timeout?: number; // request timeout in ms
}

/**
 * Parameters for a payment operation
 */
export interface PaymentParams {
  destination: string;
  amount: string;
  asset: 'XLM' | { code: string; issuer: string };
  memo?: string;
  sourceAccount?: string;
}

/**
 * Parameters for creating a new account
 */
export interface CreateAccountParams {
  destination: string;
  startingBalance: string; // minimum 1 XLM
  sourceAccount?: string;
}

/**
 * Parameters for changing a trustline
 */
export interface ChangeTrustParams {
  asset: { code: string; issuer: string } | LiquidityPoolAsset;
  limit?: string; // omit to remove trustline
  sourceAccount?: string;
}

/**
 * Parameters for managing a sell offer
 */
export interface ManageOfferParams {
  selling: { code: string; issuer: string } | 'XLM';
  buying: { code: string; issuer: string } | 'XLM';
  amount: string;
  price: string | { n: number; d: number };
  offerId?: string; // defaults to 0 (new offer)
  sourceAccount?: string;
}

/**
 * Parameters for managing a buy offer
 */
export interface ManageBuyOfferParams {
  selling: { code: string; issuer: string } | 'XLM';
  buying: { code: string; issuer: string } | 'XLM';
  amount: string;
  price: string | { n: number; d: number };
  offerId?: string; // defaults to 0 (new offer)
  sourceAccount?: string;
}

/**
 * Parameters for a path payment strict send operation
 */
export interface PathPaymentParams {
  destination: string;
  sendAsset: { code: string; issuer: string } | 'XLM';
  sendAmount: string;
  destAsset: { code: string; issuer: string } | 'XLM';
  destAmount: string;
  path?: ({ code: string; issuer: string } | 'XLM')[];
  sourceAccount?: string;
}

/**
 * Parameters for setting account options
 */
export interface SetOptionsParams {
  inflationDest?: string;
  clearFlags?: number;
  setFlags?: number;
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  homeDomain?: string;
  signer?: {
    ed25519PublicKey?: string;
    sha256Hash?: string;
    preAuthTx?: string;
    weight: number;
  };
  sourceAccount?: string;
}

/**
 * Parameters for managing account data
 */
export interface ManageDataParams {
  name: string;
  value?: string | null;
  sourceAccount?: string;
}

/**
 * Parameters for invoking a Soroban smart contract
 */
export interface InvokeContractParams {
  contractId: string;
  functionName: string;
  args?: (
    | string
    | number
    | boolean
    | { address: string }
    | { amount: string; asset: { code: string; issuer: string } | 'XLM' }
    | xdr.ScVal
  )[];
  auth?: xdr.SorobanAuthorizationEntry[];
  sourceAccount?: string;
}

/**
 * Parameters for setting transaction timebounds
 */
export interface TimeboundParams {
  minTime?: string | number; // ISO string, unix timestamp, or relative e.g. '+5m'
  maxTime?: string | number;
}

/**
 * A description of an operation added to the builder
 */
export interface OperationDescription {
  type: string;
  params:
    | PaymentParams
    | CreateAccountParams
    | ChangeTrustParams
    | ManageOfferParams
    | ManageBuyOfferParams
    | PathPaymentParams
    | SetOptionsParams
    | ManageDataParams
    | InvokeContractParams;
}

/**
 * A plain-object representation of the builder's current state
 */
export interface TxDescription {
  network: string;
  source: string;
  fee: string;
  memo?: string;
  timebounds?: { minTime: number; maxTime: number };
  operations: OperationDescription[];
}

/**
 * Options for wrapping a transaction in a fee-bump envelope
 */
export interface FeeBumpOptions {
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

/**
 * Options for restoring a fee-bump transaction envelope from XDR
 */
export interface FeeBumpFromXDROptions {
  network?: 'mainnet' | 'testnet' | 'futurenet';
  networkPassphrase?: string;
  horizonUrl?: string;
}

/**
 * A built transaction ready for signing and submission
 */
export interface BuiltTransaction {
  xdr: string;
  sign: (keypair: Keypair) => BuiltTransaction;
  submit: () => Promise<SubmitResult>;
  toXDR: () => string;
}

/**
 * An inspectable built transaction providing cryptographic hash, signature metadata,
 * and post-build fee-bump wrapping.
 */
export interface InspectableBuiltTransaction extends BuiltTransaction {
  sign(keypair: Keypair): InspectableBuiltTransaction;
  hash(): string;
  readonly signatures: readonly {
    readonly hint: string;
    readonly signature: string;
  }[];
  wrapInFeeBump(options: FeeBumpOptions): FeeBumpBuiltTransaction;
}

/**
 * A fee-bump transaction ready for outer signing and submission
 */
export interface FeeBumpBuiltTransaction extends BuiltTransaction {
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

/**
 * Result from submitting a transaction to Horizon
 */
export interface SubmitResult {
  hash: string;
  ledger: number;
  successful: boolean;
  resultXdr: string;
}
