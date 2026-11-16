import {
  Keypair,
  Networks,
  TransactionBuilder as StellarTransactionBuilder,
  TimeoutInfinite,
  Operation,
  Asset,
  LiquidityPoolAsset,
  Memo,
  Horizon,
  Transaction,
  FeeBumpTransaction,
  xdr,
  Address,
  StrKey,
  rpc,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import type {
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
  BuiltTransaction as IBuiltTransaction,
  InspectableBuiltTransaction,
  FeeBumpBuiltTransaction as IFeeBumpBuiltTransaction,
  FeeBumpOptions,
  FeeBumpFromXDROptions,
  SubmitResult,
  NetworkPassphrase,
  TxDescription,
  OperationDescription,
} from './types';
import { TxBuilderValidationError, TxBuilderNetworkError, TxBuilderSubmitError } from './errors';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Horizon API endpoints for each Stellar network
 */
const HORIZON_URLS: Record<string, string> = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
};

/**
 * Network passphrases for each Stellar network
 */
const NETWORK_PASSPHRASES: Record<string, NetworkPassphrase> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

/**
 * Mapping from recognized network passphrases to network names
 */
const PASSPHRASE_TO_NETWORK: Record<string, 'mainnet' | 'testnet' | 'futurenet'> = {
  [Networks.PUBLIC]: 'mainnet',
  [Networks.TESTNET]: 'testnet',
  [Networks.FUTURENET]: 'futurenet',
};

/**
 * Resolves a payment asset to a Stellar Asset object
 * @param asset - Either 'XLM' for native asset or a custom asset with code and issuer
 * @returns Stellar Asset instance
 * @throws Error if custom asset code or issuer is invalid
 */
function resolveAsset(asset: 'XLM' | { code: string; issuer: string }): Asset {
  if (asset === 'XLM') return Asset.native();

  if (!asset.code || typeof asset.code !== 'string') {
    throw new TxBuilderValidationError(
      'Asset code must be a non-empty string',
      'asset.code',
      asset.code,
    );
  }
  if (!asset.issuer || typeof asset.issuer !== 'string') {
    throw new TxBuilderValidationError(
      'Asset issuer must be a non-empty string',
      'asset.issuer',
      asset.issuer,
    );
  }

  try {
    return new Asset(asset.code, asset.issuer);
  } catch (error) {
    throw new TxBuilderValidationError(
      `Invalid asset: code="${asset.code}", issuer="${asset.issuer}"`,
      'asset',
      asset,
    );
  }
}

/**
 * Regular expression matching positive decimal numbers with optional scientific notation.
 * Rejects hexadecimal (0x...), binary (0b...), octal (0o...), non-finite symbols, etc.
 */
const POSITIVE_DECIMAL_REGEX = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Validates that a price string can be rationally approximated by the Stellar SDK.
 * Uses public SDK functionality (Operation.manageSellOffer probe) without relying on private methods.
 * @param price - Validated positive decimal string
 * @throws TxBuilderValidationError if the price cannot be represented as a Stellar price
 */
function validatePriceRepresentation(price: string): void {
  try {
    Operation.manageSellOffer({
      selling: Asset.native(),
      buying: Asset.native(),
      amount: '1',
      price,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'approximation failed';
    throw new TxBuilderValidationError(
      `Invalid price: "${price}" cannot be represented as a Stellar price (${message})`,
      'price',
      price,
    );
  }
}

/**
 * Resolves and validates a price parameter for Stellar offer operations.
 * Validates positive string numbers and delegates rational approximation to the Stellar SDK,
 * or validates that a fraction object has positive 32-bit integer numerator and denominator.
 * @param price - Either a positive string number or a fraction object with n (numerator) and d (denominator)
 * @returns Validated price string or fraction object
 * @throws TxBuilderValidationError if price is invalid
 */
function resolvePrice(
  price: ManageOfferParams['price'] | ManageBuyOfferParams['price'],
): string | { n: number; d: number } {
  if (typeof price === 'string') {
    const trimmed = price.trim();
    const n = Number(trimmed);
    if (
      trimmed === '' ||
      !POSITIVE_DECIMAL_REGEX.test(trimmed) ||
      isNaN(n) ||
      !isFinite(n) ||
      n <= 0
    ) {
      throw new TxBuilderValidationError(
        `Invalid price: "${price}" must be a positive number`,
        'price',
        price,
      );
    }

    validatePriceRepresentation(trimmed);

    return trimmed;
  }

  if (typeof price === 'object' && price !== null && 'n' in price && 'd' in price) {
    if (
      typeof price.n !== 'number' ||
      typeof price.d !== 'number' ||
      !Number.isFinite(price.n) ||
      !Number.isFinite(price.d) ||
      price.n <= 0 ||
      price.d <= 0
    ) {
      throw new TxBuilderValidationError(
        'Invalid price fraction: numerator and denominator must be positive',
        'price',
        price,
      );
    }

    if (!Number.isInteger(price.n) || !Number.isInteger(price.d)) {
      throw new TxBuilderValidationError(
        'Invalid price fraction: numerator and denominator must be integers',
        'price',
        price,
      );
    }

    if (price.n > 2147483647 || price.d > 2147483647) {
      throw new TxBuilderValidationError(
        'Invalid price fraction: numerator and denominator must not exceed 2147483647',
        'price',
        price,
      );
    }

    return { n: price.n, d: price.d };
  }

  throw new TxBuilderValidationError(
    'Invalid price format: must be a string or {n, d} object',
    'price',
    price,
  );
}

/**
 * Parses a timebound value into a Unix timestamp
 * @param value - Unix timestamp number, ISO date string, or relative time string (e.g., '+5m', '+1h')
 * @returns Unix timestamp in seconds
 * @throws Error if the time value cannot be parsed
 */
function parseRelativeTime(value: string | number): number {
  if (typeof value === 'number') return value;

  const now = Math.floor(Date.now() / 1000);
  const match = value.match(/^\+(\d+)(s|m|h|d)$/);
  if (match) {
    const amount = parseInt(match[1], 10);
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return now + amount * multipliers[match[2]];
  }

  const parsed = Math.floor(new Date(value).getTime() / 1000);
  if (isNaN(parsed))
    throw new TxBuilderValidationError(`Invalid time value: "${value}"`, 'time', value);
  return parsed;
}

/**
 * Validates a Stellar public key address
 * @param address - The address to validate
 * @param label - Label for error message context
 * @throws Error if the address is not a valid Stellar public key
 */
function validateAddress(address: string, label: string): void {
  if (!address || typeof address !== 'string') {
    throw new TxBuilderValidationError(`${label} must be a non-empty string`, label, address);
  }
  try {
    Keypair.fromPublicKey(address);
  } catch {
    throw new TxBuilderValidationError(
      `Invalid Stellar address for ${label}: "${address}". Expected a valid public key starting with 'G'.`,
      label,
      address,
    );
  }
}

/**
 * Validates an amount string
 * @param amount - The amount to validate
 * @param label - Label for error message context
 * @throws Error if the amount is not a positive number
 */
function validateAmount(amount: string, label: string): void {
  if (!amount || typeof amount !== 'string') {
    throw new TxBuilderValidationError(`${label} must be a non-empty string`, label, amount);
  }
  const n = parseFloat(amount);
  if (isNaN(n)) {
    throw new TxBuilderValidationError(
      `Invalid amount for ${label}: "${amount}" is not a valid number`,
      label,
      amount,
    );
  }
  if (n <= 0) {
    throw new TxBuilderValidationError(
      `Invalid amount for ${label}: "${amount}" must be greater than 0`,
      label,
      amount,
    );
  }
}

/**
 * Minimum allowable base fee per operation in stroops under Stellar protocol
 */
const MIN_BASE_FEE = 100n;

/**
 * Maximum signed 64-bit integer (2^63 - 1)
 */
const MAX_INT64 = 9223372036854775807n;

/**
 * Validates a feeSource address or Keypair
 * @param feeSource - Ed25519 public key (G...), muxed account (M...), or Keypair
 * @returns Validated account string
 * @throws TxBuilderValidationError if invalid
 */
function validateFeeSource(feeSource: unknown): string {
  if (feeSource instanceof Keypair) {
    return feeSource.publicKey();
  }
  if (typeof feeSource === 'string') {
    if (StrKey.isValidEd25519PublicKey(feeSource) || StrKey.isValidMed25519PublicKey(feeSource)) {
      return feeSource;
    }
    throw new TxBuilderValidationError(
      `Invalid feeSource address: "${feeSource}". Expected a valid G... public key or M... muxed account.`,
      'feeSource',
      feeSource,
    );
  }
  throw new TxBuilderValidationError(
    'feeSource must be a valid Stellar public key string (G... or M...) or Keypair instance',
    'feeSource',
    feeSource,
  );
}

/**
 * Extracts the Soroban resource fee from an inner transaction as a BigInt.
 */
function getSorobanResourceFee(tx: Transaction): bigint {
  const env = tx.toEnvelope();
  if (env.switch().value === xdr.EnvelopeType.envelopeTypeTx().value) {
    const sorobanData = env.v1().tx().ext().value();
    if (sorobanData && typeof sorobanData.resourceFee === 'function') {
      const rf = sorobanData.resourceFee();
      if (rf !== null && rf !== undefined) {
        return BigInt(rf.toString());
      }
    }
  }
  return 0n;
}

/**
 * Calculates the inner transaction inclusion fee rate (ceiling divided) and operation counts.
 */
function calculateInnerInclusionRate(tx: Transaction): {
  innerOps: bigint;
  resourceFee: bigint;
  ceilRate: bigint;
} {
  const innerOps = BigInt(tx.operations.length);
  const resourceFee = getSorobanResourceFee(tx);
  const innerTotalFee = BigInt(tx.fee.toString());
  const innerInclusionFee = innerTotalFee - resourceFee;

  let ceilRate = 0n;
  if (innerInclusionFee > 0n && innerOps > 0n) {
    ceilRate = (innerInclusionFee + innerOps - 1n) / innerOps;
  }
  return { innerOps, resourceFee, ceilRate };
}

/**
 * Validates or calculates the base fee rate for a fee-bump transaction using BigInt arithmetic.
 */
function resolveFeeBumpBaseFee(baseFee: string | number | undefined, innerTx: Transaction): bigint {
  const { innerOps, resourceFee, ceilRate } = calculateInnerInclusionRate(innerTx);

  let parsedBaseFee: bigint;

  if (baseFee === undefined || baseFee === null) {
    // defaultBaseFee = max(100, ceil(innerInclusionFeeRate))
    parsedBaseFee = ceilRate > MIN_BASE_FEE ? ceilRate : MIN_BASE_FEE;
  } else if (typeof baseFee === 'number') {
    if (!Number.isSafeInteger(baseFee)) {
      throw new TxBuilderValidationError(
        `baseFee must be a safe integer, got: ${baseFee}`,
        'baseFee',
        baseFee,
      );
    }
    if (baseFee <= 0) {
      throw new TxBuilderValidationError(
        `baseFee must be a positive integer, got: ${baseFee}`,
        'baseFee',
        baseFee,
      );
    }
    parsedBaseFee = BigInt(baseFee);
  } else if (typeof baseFee === 'string') {
    const trimmed = baseFee.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new TxBuilderValidationError(
        `baseFee must be an integer decimal string, got: "${baseFee}"`,
        'baseFee',
        baseFee,
      );
    }
    parsedBaseFee = BigInt(trimmed);
    if (parsedBaseFee <= 0n) {
      throw new TxBuilderValidationError(
        `baseFee must be greater than 0, got: "${baseFee}"`,
        'baseFee',
        baseFee,
      );
    }
  } else {
    throw new TxBuilderValidationError(
      'baseFee must be an integer decimal string or safe integer number',
      'baseFee',
      baseFee,
    );
  }

  if (parsedBaseFee < MIN_BASE_FEE) {
    throw new TxBuilderValidationError(
      `baseFee should be at least ${MIN_BASE_FEE} stroops, got: ${parsedBaseFee}`,
      'baseFee',
      baseFee,
    );
  }

  if (parsedBaseFee < ceilRate) {
    throw new TxBuilderValidationError(
      `Invalid baseFee, it should be at least ${ceilRate} stroops.`,
      'baseFee',
      baseFee,
    );
  }

  // Check outer total fee overflow against signed Int64:
  // outer fee = baseFee * (innerOps + 1) + resourceFee
  const totalOuterFee = parsedBaseFee * (innerOps + 1n) + resourceFee;
  if (totalOuterFee > MAX_INT64) {
    throw new TxBuilderValidationError(
      `Total fee-bump fee (${totalOuterFee}) exceeds maximum signed 64-bit integer (${MAX_INT64})`,
      'baseFee',
      baseFee,
    );
  }

  return parsedBaseFee;
}

// ── BuiltTransaction impl ──────────────────────────────────────────────────

/**
 * Internal implementation of BuiltTransaction interface
 * Wraps a Stellar Transaction and Horizon Server for signing and submission
 */
class BuiltTransactionImpl implements InspectableBuiltTransaction {
  private tx: Transaction;
  private server: Horizon.Server;
  xdr: string;

  constructor(tx: Transaction, server: Horizon.Server) {
    this.tx = tx;
    this.server = server;
    this.xdr = tx.toXDR();
  }

  /**
   * Signs the transaction with the provided keypair.
   * If the keypair has already signed this transaction envelope, this is a safe no-op.
   * Enforces the Stellar limit of 20 signatures per transaction envelope.
   *
   * @param keypair - The keypair to sign with
   * @returns This instance for chaining
   * @throws TxBuilderValidationError if the envelope already has 20 signatures from other signers
   */
  sign(keypair: Keypair): InspectableBuiltTransaction {
    // 1. Check if this keypair has already signed this transaction (cryptographic check)
    const alreadySigned = this.tx.signatures.some((sig) => {
      try {
        if (!sig.hint().equals(keypair.signatureHint())) return false;
        return keypair.verify(this.tx.hash(), sig.signature());
      } catch {
        return false;
      }
    });

    if (alreadySigned) {
      return this;
    }

    // 2. Enforce the Stellar 20-signature envelope limit before mutating the transaction
    if (this.tx.signatures.length >= 20) {
      throw new TxBuilderValidationError(
        'Cannot sign transaction: maximum limit of 20 signatures reached for a Stellar transaction envelope',
        'signatures',
        this.tx.signatures.length,
      );
    }

    // 3. Append signature and synchronize cached XDR
    this.tx.sign(keypair);
    this.xdr = this.tx.toXDR();
    return this;
  }

  /**
   * Returns the transaction hash as a hexadecimal string
   * @returns 64-character hex hash string
   */
  hash(): string {
    return this.tx.hash().toString('hex');
  }

  /**
   * Returns a read-only list of decorated signatures present on the envelope
   */
  get signatures(): readonly { readonly hint: string; readonly signature: string }[] {
    return Object.freeze(
      this.tx.signatures.map((sig) =>
        Object.freeze({
          hint: sig.hint().toString('hex'),
          signature: sig.signature().toString('hex'),
        }),
      ),
    );
  }

  /**
   * Returns the current XDR representation of the transaction
   * @returns XDR string
   */
  toXDR(): string {
    return this.tx.toXDR();
  }

  /**
   * Wraps this signed built transaction in a CAP-0015 fee-bump envelope.
   *
   * The inner transaction must be signed before wrapping.
   *
   * Note: The presence of one or more signatures does NOT establish that the transaction
   * has satisfied its required signing thresholds (e.g. for multisig accounts). Stellar Flow
   * does not verify complete account authorization offline. The caller remains responsible
   * for ensuring all required inner signers have signed before wrapping.
   *
   * @param options - Fee-bump options containing feeSource and optional baseFee rate
   * @returns FeeBumpBuiltTransaction ready for outer fee-source signing and submission
   * @throws TxBuilderValidationError if inner transaction has zero signatures, options are invalid,
   *         or fee rules are violated
   */
  wrapInFeeBump(options: FeeBumpOptions): FeeBumpBuiltTransaction {
    if (!options || typeof options !== 'object') {
      throw new TxBuilderValidationError('FeeBumpOptions must be an object', 'options', options);
    }

    if (this.tx.signatures.length === 0) {
      throw new TxBuilderValidationError(
        'Cannot wrap an unsigned transaction in a fee-bump envelope. The inner transaction must have at least one signature before wrapping.',
        'signatures',
        0,
      );
    }

    const feeSourceAddress = validateFeeSource(options.feeSource);
    const baseFeeRate = resolveFeeBumpBaseFee(options.baseFee, this.tx);

    const feeBumpTx = StellarTransactionBuilder.buildFeeBumpTransaction(
      feeSourceAddress,
      baseFeeRate.toString(),
      this.tx,
      this.tx.networkPassphrase,
    );

    return new FeeBumpBuiltTransactionImpl(feeBumpTx, this.server);
  }

  /**
   * Submits the signed transaction to the Horizon network
   * @returns SubmitResult with transaction hash, ledger, and success status
   * @throws Error if submission fails
   */
  async submit(): Promise<SubmitResult> {
    try {
      const response = await this.server.submitTransaction(this.tx);
      return {
        hash: response.hash,
        ledger: response.ledger,
        successful: response.successful,
        resultXdr: response.result_xdr,
      };
    } catch (e: any) {
      if (e.response?.data?.extras?.result_codes) {
        throw new TxBuilderSubmitError(
          e.message || 'Transaction submission failed',
          e.response.data.extras.result_codes,
        );
      }
      throw new TxBuilderNetworkError(e.message || 'Network error during submission');
    }
  }

  /**
   * Restores a BuiltTransaction directly from an existing XDR transaction envelope.
   * Preserves all existing signatures, Soroban transaction data, and operation auth entries.
   *
   * @param xdrString - Base64-encoded XDR transaction envelope
   * @param options - Builder options including network and optional Horizon URL
   * @returns InspectableBuiltTransaction instance ready for additional signatures or submission
   * @throws TxBuilderValidationError if XDR is invalid, network is unknown, or envelope is a fee-bump
   */
  static fromXDR(xdrString: string, options: TxBuilderOptions): InspectableBuiltTransaction {
    if (!xdrString || typeof xdrString !== 'string') {
      throw new TxBuilderValidationError(
        'Transaction XDR must be a non-empty string',
        'xdr',
        xdrString,
      );
    }

    if (!options || typeof options !== 'object') {
      throw new TxBuilderValidationError(
        'options must be provided and contain a valid network',
        'options',
        options,
      );
    }

    const passphrase = NETWORK_PASSPHRASES[options.network];
    if (!passphrase) {
      throw new TxBuilderValidationError(
        `Unknown network: ${options.network}`,
        'network',
        options.network,
      );
    }

    let tx: Transaction;
    try {
      tx = new Transaction(xdrString, passphrase);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (/envelopeTypeTxFeeBump/i.test(message)) {
        throw new TxBuilderValidationError(
          `Fee-bump envelopes are not supported by BuiltTransaction.fromXDR(). Use FeeBumpBuiltTransaction.fromXDR() to parse fee-bump envelopes: ${message}`,
          'xdr',
          xdrString,
        );
      }
      throw new TxBuilderValidationError(
        `Failed to parse transaction XDR: ${message}`,
        'xdr',
        xdrString,
      );
    }

    const horizonUrl = options.horizonUrl ?? HORIZON_URLS[options.network];
    const server = new Horizon.Server(horizonUrl);
    return new BuiltTransactionImpl(tx, server);
  }
}

/**
 * A built transaction ready for signing and submission
 */
export interface BuiltTransaction extends IBuiltTransaction {}

/**
 * Public companion object providing factory methods for BuiltTransaction
 */
export const BuiltTransaction = {
  /**
   * Restores an existing transaction envelope from base64 XDR without modifying sequence numbers
   * or discarding existing signatures and Soroban metadata.
   *
   * @param xdrString - Base64 XDR transaction envelope
   * @param options - Builder options including network
   * @returns InspectableBuiltTransaction ready for additional signatures or submission
   */
  fromXDR(xdrString: string, options: TxBuilderOptions): InspectableBuiltTransaction {
    return BuiltTransactionImpl.fromXDR(xdrString, options);
  },
};

// ── FeeBumpBuiltTransaction impl ──────────────────────────────────────────

/**
 * Internal implementation of FeeBumpBuiltTransaction interface
 * Wraps a Stellar FeeBumpTransaction and Horizon Server for outer signing and submission
 */
class FeeBumpBuiltTransactionImpl implements FeeBumpBuiltTransaction {
  private feeBumpTx: FeeBumpTransaction;
  private server: Horizon.Server;
  xdr: string;

  constructor(feeBumpTx: FeeBumpTransaction, server: Horizon.Server) {
    this.feeBumpTx = feeBumpTx;
    this.server = server;
    this.xdr = feeBumpTx.toXDR();
  }

  get feeSource(): string {
    return this.feeBumpTx.feeSource;
  }

  get fee(): string {
    return this.feeBumpTx.fee.toString();
  }

  get innerSource(): string {
    return this.feeBumpTx.innerTransaction.source;
  }

  hash(): string {
    return this.feeBumpTx.hash().toString('hex');
  }

  innerHash(): string {
    return this.feeBumpTx.innerTransaction.hash().toString('hex');
  }

  get signatures(): readonly { readonly hint: string; readonly signature: string }[] {
    return Object.freeze(
      this.feeBumpTx.signatures.map((sig) =>
        Object.freeze({
          hint: sig.hint().toString('hex'),
          signature: sig.signature().toString('hex'),
        }),
      ),
    );
  }

  get innerSignatures(): readonly { readonly hint: string; readonly signature: string }[] {
    return Object.freeze(
      this.feeBumpTx.innerTransaction.signatures.map((sig) =>
        Object.freeze({
          hint: sig.hint().toString('hex'),
          signature: sig.signature().toString('hex'),
        }),
      ),
    );
  }

  toXDR(): string {
    return this.feeBumpTx.toXDR();
  }

  innerToXDR(): string {
    return this.feeBumpTx.innerTransaction.toXDR();
  }

  sign(keypair: Keypair): FeeBumpBuiltTransaction {
    if (!keypair || typeof keypair.sign !== 'function') {
      throw new TxBuilderValidationError(
        'A valid Keypair is required to sign fee-bump transaction',
        'keypair',
        keypair,
      );
    }

    // 1. Check if keypair already signed the outer fee-bump envelope (cryptographic check)
    const outerHash = this.feeBumpTx.hash();
    const alreadySigned = this.feeBumpTx.signatures.some((sig) => {
      try {
        if (!sig.hint().equals(keypair.signatureHint())) return false;
        return keypair.verify(outerHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (alreadySigned) {
      return this;
    }

    // 2. Enforce the Stellar 20-signature envelope limit for the outer envelope
    if (this.feeBumpTx.signatures.length >= 20) {
      throw new TxBuilderValidationError(
        'Cannot sign fee-bump transaction: maximum limit of 20 signatures reached for outer envelope',
        'signatures',
        this.feeBumpTx.signatures.length,
      );
    }

    // 3. Append signature and synchronize cached XDR
    this.feeBumpTx.sign(keypair);
    this.xdr = this.feeBumpTx.toXDR();
    return this;
  }

  async submit(): Promise<SubmitResult> {
    try {
      const response = await this.server.submitTransaction(this.feeBumpTx);
      return {
        hash: response.hash,
        ledger: response.ledger,
        successful: response.successful,
        resultXdr: response.result_xdr,
      };
    } catch (e: any) {
      if (e.response?.data?.extras?.result_codes) {
        throw new TxBuilderSubmitError(
          e.message || 'Transaction submission failed',
          e.response.data.extras.result_codes,
        );
      }
      throw new TxBuilderNetworkError(e.message || 'Network error during submission');
    }
  }

  static fromXDR(xdrString: string, options?: FeeBumpFromXDROptions): FeeBumpBuiltTransaction {
    if (!xdrString || typeof xdrString !== 'string') {
      throw new TxBuilderValidationError(
        'Fee-bump transaction XDR must be a non-empty string',
        'xdr',
        xdrString,
      );
    }

    const network = options?.network;
    if (network && !NETWORK_PASSPHRASES[network]) {
      throw new TxBuilderValidationError(`Unknown network: ${network}`, 'network', network);
    }

    if (
      network &&
      options?.networkPassphrase !== undefined &&
      NETWORK_PASSPHRASES[network] !== options.networkPassphrase
    ) {
      throw new TxBuilderValidationError(
        `Conflicting network ("${network}") and networkPassphrase ("${options.networkPassphrase}") provided`,
        'network',
        network,
      );
    }

    const passphrase =
      options?.networkPassphrase ?? (network ? NETWORK_PASSPHRASES[network] : undefined);

    if (!passphrase) {
      throw new TxBuilderValidationError(
        'Network or networkPassphrase is required to parse fee-bump transaction XDR',
        'network',
        undefined,
      );
    }

    let parsed: Transaction | FeeBumpTransaction;
    try {
      parsed = StellarTransactionBuilder.fromXDR(xdrString, passphrase);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      throw new TxBuilderValidationError(
        `Failed to parse fee-bump transaction XDR: ${message}`,
        'xdr',
        xdrString,
      );
    }

    if (!(parsed instanceof FeeBumpTransaction)) {
      throw new TxBuilderValidationError(
        'Parsed envelope is an ordinary transaction, not a fee-bump transaction. Use BuiltTransaction.fromXDR() to parse ordinary transactions.',
        'xdr',
        xdrString,
      );
    }

    let horizonUrl = options?.horizonUrl;
    if (!horizonUrl) {
      if (network && HORIZON_URLS[network]) {
        horizonUrl = HORIZON_URLS[network];
      } else if (passphrase && PASSPHRASE_TO_NETWORK[passphrase]) {
        horizonUrl = HORIZON_URLS[PASSPHRASE_TO_NETWORK[passphrase]];
      } else {
        throw new TxBuilderValidationError(
          'horizonUrl is required when using a custom networkPassphrase without a recognized network',
          'horizonUrl',
          undefined,
        );
      }
    }
    const server = new Horizon.Server(horizonUrl);
    return new FeeBumpBuiltTransactionImpl(parsed, server);
  }
}

/**
 * A fee-bump transaction ready for outer signing and submission
 */
export interface FeeBumpBuiltTransaction extends IFeeBumpBuiltTransaction {}

/**
 * Public companion object providing factory methods for FeeBumpBuiltTransaction
 */
export const FeeBumpBuiltTransaction = {
  /**
   * Restores an existing fee-bump transaction envelope from base64 XDR.
   * Preserves inner and outer signatures, fee source, fee, and Soroban metadata.
   *
   * @param xdrString - Base64 XDR fee-bump transaction envelope
   * @param options - Fee-bump deserialization options including network or networkPassphrase
   * @returns FeeBumpBuiltTransaction ready for additional outer signatures or submission
   */
  fromXDR(xdrString: string, options?: FeeBumpFromXDROptions): FeeBumpBuiltTransaction {
    return FeeBumpBuiltTransactionImpl.fromXDR(xdrString, options);
  },
};

// ── TxBuilder ──────────────────────────────────────────────────────────────

/**
 * Fluent builder for constructing Stellar transactions
 * Provides a chainable API for adding operations, setting memos/timebounds,
 * building, signing, and submitting transactions
 */
export class TxBuilder {
  private keypair: Keypair;
  private options: TxBuilderOptions;
  private operations: xdr.Operation[] = [];
  private descriptors: OperationDescription[] = [];
  private memo?: Memo;
  private timebounds?: { minTime: number; maxTime: number };

  private constructor(keypair: Keypair, options: TxBuilderOptions) {
    this.keypair = keypair;
    this.options = options;
  }

  /**
   * Entry point — create a builder for a given keypair and network
   * @param keypair - Source account keypair
   * @param options - Builder options including network, fee, and Horizon URL
   * @returns New TxBuilder instance
   */
  static for(keypair: Keypair, options: TxBuilderOptions): TxBuilder {
    return new TxBuilder(keypair, options);
  }

  /**
   * Reconstruct a TxBuilder from an existing XDR transaction envelope.
   * Useful for resuming, inspecting, or adding operations to a transaction created elsewhere.
   *
   * @param xdr - The base64 XDR transaction envelope
   * @param options - Builder options (network is required)
   * @returns A restored TxBuilder instance
   * @throws TxBuilderValidationError if an operation is not supported by stellar-flow
   */
  static fromXDR(xdrString: string, options: TxBuilderOptions): TxBuilder {
    let tx;
    try {
      const passphrase = NETWORK_PASSPHRASES[options.network];
      tx = new Transaction(xdrString, passphrase);
    } catch (e: any) {
      throw new TxBuilderValidationError(`Failed to parse XDR: ${e.message}`, 'xdr', xdrString);
    }

    // Reconstruct a public-only keypair for the source account
    const sourceKeypair = Keypair.fromPublicKey(tx.source);

    // Create builder with parsed fee (Stellar SDK tx.fee is total fee, options.fee is base fee)
    const baseFee = Math.floor(parseInt(tx.fee, 10) / Math.max(1, tx.operations.length)).toString();

    const builder = TxBuilder.for(sourceKeypair, {
      ...options,
      fee: options.fee ?? baseFee,
    });

    if (tx.memo && tx.memo.type !== 'none') {
      if (tx.memo.type === 'text' && tx.memo.value) {
        builder.setMemo(tx.memo.value.toString('utf8'));
      } else {
        // Fallback for non-text memos which stellar-flow doesn't fully expose via builder yet,
        // but we can just set the raw memo directly to avoid losing it.
        builder.memo = tx.memo;
      }
    }

    if (tx.timeBounds) {
      // In stellar-sdk, timeBounds minTime and maxTime are strings
      builder.timebounds = {
        minTime: parseInt(tx.timeBounds.minTime, 10),
        maxTime: parseInt(tx.timeBounds.maxTime, 10),
      };
    }

    // Map operations
    for (const op of tx.operations) {
      mapParsedOperation(builder, op);
    }

    return builder;
  }

  // ── operations ────────────────────────────────────────────────────────

  /**
   * Adds a payment operation to the transaction
   * @param params - Payment parameters including destination, amount, and asset
   * @returns This instance for chaining
   * @throws Error if destination address or amount is invalid
   */
  addPayment(params: PaymentParams): this {
    validateAddress(params.destination, 'destination');
    validateAmount(params.amount, 'payment');
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    this.operations.push(
      Operation.payment({
        destination: params.destination,
        asset: resolveAsset(params.asset),
        amount: params.amount,
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({ type: 'payment', params });

    if (params.memo) this.memo = Memo.text(params.memo);
    return this;
  }

  /**
   * Adds a create account operation to the transaction
   * @param params - Create account parameters including destination and starting balance
   * @returns This instance for chaining
   * @throws Error if destination address or starting balance is invalid
   */
  addCreateAccount(params: CreateAccountParams): this {
    validateAddress(params.destination, 'destination');
    validateAmount(params.startingBalance, 'startingBalance');
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    this.operations.push(
      Operation.createAccount({
        destination: params.destination,
        startingBalance: params.startingBalance,
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({ type: 'createAccount', params });
    return this;
  }

  /**
   * Adds a change trust operation to the transaction
   * @param params - Change trust parameters including asset and optional limit
   * @returns This instance for chaining
   */
  addChangeTrust(params: ChangeTrustParams): this {
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }
    const asset =
      params.asset instanceof LiquidityPoolAsset
        ? params.asset
        : resolveAsset({ code: params.asset.code, issuer: params.asset.issuer });
    this.operations.push(
      Operation.changeTrust({
        asset,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({ type: 'changeTrust', params });
    return this;
  }

  /**
   * Adds a manage sell offer operation to the transaction
   * @param params - Manage offer parameters including selling/buying assets, amount, price, and optional offer ID
   * @returns This instance for chaining
   * @throws Error if parameters are invalid
   */
  addManageOffer(params: ManageOfferParams): this {
    validateAmount(params.amount, 'offer amount');
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    const selling = resolveAsset(params.selling);
    const buying = resolveAsset(params.buying);
    const price = resolvePrice(params.price);

    this.operations.push(
      Operation.manageSellOffer({
        selling,
        buying,
        amount: params.amount,
        price,
        offerId: params.offerId || '0',
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({ type: 'manageSellOffer', params });
    return this;
  }

  /**
   * Adds a manage buy offer operation to the transaction
   * @param params - Manage buy offer parameters including selling/buying assets, amount, price, and optional offer ID
   * @returns This instance for chaining
   * @throws Error if parameters are invalid
   */
  addManageBuyOffer(params: ManageBuyOfferParams): this {
    validateAmount(params.amount, 'buy offer amount');
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    const selling = resolveAsset(params.selling);
    const buying = resolveAsset(params.buying);
    const price = resolvePrice(params.price);

    this.operations.push(
      Operation.manageBuyOffer({
        selling,
        buying,
        buyAmount: params.amount,
        price,
        offerId: params.offerId || '0',
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({ type: 'manageBuyOffer', params });
    return this;
  }

  /**
   * Adds a path payment strict send operation to the transaction
   * @param params - Path payment parameters including destination, send/dest assets and amounts, and optional path
   * @returns This instance for chaining
   * @throws Error if parameters are invalid
   */
  addPathPayment(params: PathPaymentParams): this {
    validateAddress(params.destination, 'destination');
    validateAmount(params.sendAmount, 'send amount');
    validateAmount(params.destAmount, 'destination amount');
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    const sendAsset = resolveAsset(params.sendAsset);
    const destAsset = resolveAsset(params.destAsset);
    const path = params.path ? params.path.map(resolveAsset) : [];

    this.operations.push(
      Operation.pathPaymentStrictSend({
        destination: params.destination,
        sendAsset,
        sendAmount: params.sendAmount,
        destAsset,
        destMin: params.destAmount,
        path,
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({ type: 'pathPaymentStrictSend', params });
    return this;
  }

  /**
   * Adds a set options operation to the transaction
   * @param params - Set options parameters for account configuration
   * @returns This instance for chaining
   * @throws Error if parameters are invalid
   */
  addSetOptions(params: SetOptionsParams): this {
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    const operationParams: Record<string, unknown> = {};

    if (params.sourceAccount) {
      operationParams.source = params.sourceAccount;
    }

    if (params.inflationDest !== undefined) {
      validateAddress(params.inflationDest, 'inflation destination');
      operationParams.inflationDest = params.inflationDest;
    }

    if (params.clearFlags !== undefined) {
      operationParams.clearFlags = params.clearFlags;
    }

    if (params.setFlags !== undefined) {
      operationParams.setFlags = params.setFlags;
    }

    if (params.masterWeight !== undefined) {
      if (params.masterWeight < 0 || params.masterWeight > 255) {
        throw new TxBuilderValidationError(
          'Master weight must be between 0 and 255',
          'masterWeight',
          params.masterWeight,
        );
      }
      operationParams.masterWeight = params.masterWeight;
    }

    if (params.lowThreshold !== undefined) {
      if (params.lowThreshold < 0 || params.lowThreshold > 255) {
        throw new TxBuilderValidationError(
          'Low threshold must be between 0 and 255',
          'lowThreshold',
          params.lowThreshold,
        );
      }
      operationParams.lowThreshold = params.lowThreshold;
    }

    if (params.medThreshold !== undefined) {
      if (params.medThreshold < 0 || params.medThreshold > 255) {
        throw new TxBuilderValidationError(
          'Medium threshold must be between 0 and 255',
          'medThreshold',
          params.medThreshold,
        );
      }
      operationParams.medThreshold = params.medThreshold;
    }

    if (params.highThreshold !== undefined) {
      if (params.highThreshold < 0 || params.highThreshold > 255) {
        throw new TxBuilderValidationError(
          'High threshold must be between 0 and 255',
          'highThreshold',
          params.highThreshold,
        );
      }
      operationParams.highThreshold = params.highThreshold;
    }

    if (params.homeDomain !== undefined) {
      if (params.homeDomain.length > 32) {
        throw new TxBuilderValidationError(
          'Home domain must be 32 characters or fewer',
          'homeDomain',
          params.homeDomain,
        );
      }
      operationParams.homeDomain = params.homeDomain;
    }

    if (params.signer !== undefined) {
      if (params.signer.weight < 0 || params.signer.weight > 255) {
        throw new TxBuilderValidationError(
          'Signer weight must be between 0 and 255',
          'signer.weight',
          params.signer.weight,
        );
      }

      const signer: Record<string, unknown> = { weight: params.signer.weight };

      if (params.signer.ed25519PublicKey) {
        validateAddress(params.signer.ed25519PublicKey, 'signer public key');
        signer.ed25519PublicKey = params.signer.ed25519PublicKey;
      } else if (params.signer.sha256Hash) {
        if (typeof params.signer.sha256Hash === 'string') {
          if (params.signer.sha256Hash.length !== 64) {
            throw new TxBuilderValidationError(
              'SHA256 hash must be 64 hex characters (32 bytes)',
              'signer.sha256Hash',
              params.signer.sha256Hash,
            );
          }
          signer.sha256Hash = Buffer.from(params.signer.sha256Hash, 'hex');
        } else {
          signer.sha256Hash = params.signer.sha256Hash;
        }
      } else if (params.signer.preAuthTx) {
        if (typeof params.signer.preAuthTx === 'string') {
          if (params.signer.preAuthTx.length !== 64) {
            throw new TxBuilderValidationError(
              'PreAuthTx must be 64 hex characters (32 bytes)',
              'signer.preAuthTx',
              params.signer.preAuthTx,
            );
          }
          signer.preAuthTx = Buffer.from(params.signer.preAuthTx, 'hex');
        } else {
          signer.preAuthTx = params.signer.preAuthTx;
        }
      } else {
        throw new TxBuilderValidationError(
          'Signer must specify one of: ed25519PublicKey, sha256Hash, or preAuthTx',
          'signer',
          params.signer,
        );
      }

      operationParams.signer = signer;
    }

    this.operations.push(Operation.setOptions(operationParams));
    this.descriptors.push({ type: 'setOptions', params });
    return this;
  }

  /**
   * Adds a manage data operation to the transaction
   * @param params - Manage data parameters including name and value
   * @returns This instance for chaining
   * @throws Error if parameters are invalid
   */
  addManageData(params: ManageDataParams): this {
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    if (!params.name || typeof params.name !== 'string') {
      throw new TxBuilderValidationError(
        'Data name must be a non-empty string',
        'name',
        params.name,
      );
    }

    const nameBytes = Buffer.byteLength(params.name, 'utf8');
    if (nameBytes > 64) {
      throw new TxBuilderValidationError(
        `Data name exceeds 64-byte limit (${nameBytes} bytes)`,
        'name',
        params.name,
      );
    }

    const normalizedValue = params.value === undefined ? null : params.value;

    if (normalizedValue !== null) {
      if (typeof normalizedValue !== 'string') {
        throw new TxBuilderValidationError(
          'Data value must be a string or null',
          'value',
          params.value,
        );
      }

      const valueBytes = Buffer.byteLength(normalizedValue, 'utf8');
      if (valueBytes > 64) {
        throw new TxBuilderValidationError(
          `Data value exceeds 64-byte limit (${valueBytes} bytes)`,
          'value',
          params.value,
        );
      }
    }

    this.operations.push(
      Operation.manageData({
        name: params.name,
        value: normalizedValue,
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({
      type: 'manageData',
      params: {
        name: params.name,
        value: normalizedValue,
        ...(params.sourceAccount ? { sourceAccount: params.sourceAccount } : {}),
      },
    });
    return this;
  }

  /**
   * Adds a Soroban smart contract invocation operation to the transaction
   * @param params - Invoke contract parameters including contract ID, function name, arguments, and optional authorization entries
   * @returns This instance for chaining
   * @throws TxBuilderValidationError if parameters are invalid
   */
  invokeContract(params: InvokeContractParams): this {
    if (params.sourceAccount !== undefined) {
      validateAddress(params.sourceAccount, 'sourceAccount');
    }

    if (!params.contractId || typeof params.contractId !== 'string') {
      throw new TxBuilderValidationError(
        'Contract ID must be a non-empty string',
        'contractId',
        params.contractId,
      );
    }

    if (!params.functionName || typeof params.functionName !== 'string') {
      throw new TxBuilderValidationError(
        'Function name must be a non-empty string',
        'functionName',
        params.functionName,
      );
    }

    let contractAddress: Address;
    try {
      contractAddress = new Address(params.contractId);
    } catch (error) {
      throw new TxBuilderValidationError(
        'Invalid contract ID format',
        'contractId',
        params.contractId,
      );
    }

    let auth: xdr.SorobanAuthorizationEntry[] = [];
    if (params.auth !== undefined) {
      if (!Array.isArray(params.auth)) {
        throw new TxBuilderValidationError(
          'Authorization entries must be an array',
          'auth',
          params.auth,
        );
      }
      for (const entry of params.auth) {
        if (!(entry instanceof xdr.SorobanAuthorizationEntry)) {
          throw new TxBuilderValidationError(
            'Invalid authorization entry: each entry must be an instance of xdr.SorobanAuthorizationEntry',
            'auth',
            entry,
          );
        }
      }
      auth = params.auth;
    }

    let scValArgs: xdr.ScVal[] = [];
    if (params.args) {
      scValArgs = params.args.map((arg) => {
        if (arg instanceof xdr.ScVal) return arg;
        if (typeof arg === 'object' && arg !== null) {
          const obj = arg as Record<string, unknown>;
          if ('address' in obj && typeof obj.address === 'string') {
            return nativeToScVal(obj.address, { type: 'address' });
          }
        }
        return nativeToScVal(arg);
      });
    }

    this.operations.push(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: contractAddress.toScAddress(),
            functionName: params.functionName,
            args: scValArgs,
          }),
        ),
        auth,
        ...(params.sourceAccount ? { source: params.sourceAccount } : {}),
      }),
    );
    this.descriptors.push({ type: 'invokeContract', params });
    return this;
  }

  /**
   * @deprecated Fee-bump wrapping must be performed on a signed built transaction, not during builder configuration.
   * Build and sign the inner transaction first, then call `tx.wrapInFeeBump({ feeSource, baseFee })`.
   *
   * ```typescript
   * const tx = await builder.build();
   * tx.sign(sourceKeypair);
   * const feeBump = tx.wrapInFeeBump({ feeSource, baseFee });
   * feeBump.sign(sponsorKeypair);
   * await feeBump.submit();
   * ```
   *
   * @param _feeSource - Public key of the account paying the fee
   * @param _fee - Optional fee in stroops
   * @throws Error always explaining how to use post-build fee-bump wrapping
   */
  wrapInFeeBump(_feeSource: string, _fee?: string): this {
    throw new Error(
      'TxBuilder.wrapInFeeBump() is deprecated and not supported. ' +
        'Fee-bump wrapping must be performed on a signed built transaction:\n' +
        '  const tx = await builder.build();\n' +
        '  tx.sign(sourceKeypair);\n' +
        '  const feeBump = tx.wrapInFeeBump({ feeSource, baseFee });\n' +
        '  feeBump.sign(sponsorKeypair);\n' +
        '  await feeBump.submit();',
    );
  }

  /**
   * Sets a text memo for the transaction
   * @param text - Memo text (max 28 bytes)
   * @returns This instance for chaining
   * @throws Error if memo exceeds 28 bytes or is empty
   */
  setMemo(text: string): this {
    if (!text || typeof text !== 'string') {
      throw new TxBuilderValidationError('Memo must be a non-empty string', 'memo', text);
    }
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > 28)
      throw new TxBuilderValidationError(
        `Memo text exceeds 28-byte limit (${byteLength} bytes)`,
        'memo',
        text,
      );
    this.memo = Memo.text(text);
    return this;
  }

  /**
   * Sets timebounds for the transaction validity window
   * @param bounds - Timebound parameters with optional minTime and maxTime
   * @returns This instance for chaining
   */
  setTimebounds(bounds: TimeboundParams): this {
    this.timebounds = {
      minTime: bounds.minTime !== undefined ? parseRelativeTime(bounds.minTime) : 0,
      maxTime: bounds.maxTime !== undefined ? parseRelativeTime(bounds.maxTime) : 0,
    };
    return this;
  }

  // ── inspection ────────────────────────────────────────────────────────

  /**
   * Returns a plain-object description of the builder's current state.
   * Useful for AI agents to inspect and validate a transaction before building.
   * @returns TxDescription object
   */
  describe(): TxDescription {
    return {
      network: this.options.network,
      source: this.keypair.publicKey(),
      fee: this.options.fee ?? '100',
      memo: this.memo?.value?.toString() || undefined,
      timebounds: this.timebounds,
      operations: [...this.descriptors],
    };
  }

  // ── build ─────────────────────────────────────────────────────────────

  /**
   * Builds the transaction by loading the source account from Horizon
   * and assembling all operations, memos, and timebounds
   * @returns InspectableBuiltTransaction ready for signing and submission
   * @throws Error if no operations have been added
   */
  async build(): Promise<InspectableBuiltTransaction> {
    if (this.operations.length === 0)
      throw new TxBuilderValidationError('Cannot build a transaction with no operations');

    const horizonUrl = this.options.horizonUrl ?? HORIZON_URLS[this.options.network];
    const passphrase = NETWORK_PASSPHRASES[this.options.network];
    const server = new Horizon.Server(horizonUrl);

    let sourceAccount;
    try {
      sourceAccount = await server.loadAccount(this.keypair.publicKey());
    } catch (e: any) {
      throw new TxBuilderNetworkError(`Failed to load source account: ${e.message}`);
    }

    const builder = new StellarTransactionBuilder(sourceAccount, {
      fee: this.options.fee ?? '100',
      networkPassphrase: passphrase,
    });

    for (const op of this.operations) {
      builder.addOperation(op);
    }

    if (this.memo) builder.addMemo(this.memo);

    // Apply timebounds if set, otherwise use TimeoutInfinite
    if (this.timebounds) {
      builder.setTimebounds(this.timebounds.minTime, this.timebounds.maxTime);
    } else {
      builder.setTimeout(TimeoutInfinite);
    }

    const tx = builder.build() as Transaction;

    let finalTx = tx;
    const hasSoroban = this.operations.some(
      (op) => op.body().switch() === xdr.OperationType.invokeHostFunction(),
    );

    if (hasSoroban) {
      if (!this.options.sorobanUrl) {
        throw new TxBuilderValidationError(
          'sorobanUrl is required in TxBuilderOptions when invoking a Soroban contract',
          'sorobanUrl',
          undefined,
        );
      }
      const sorobanServer = new rpc.Server(this.options.sorobanUrl);
      try {
        finalTx = (await sorobanServer.prepareTransaction(tx)) as Transaction;
      } catch (e: any) {
        throw new TxBuilderNetworkError(`Failed to prepare Soroban transaction: ${e.message}`);
      }
    }

    return new BuiltTransactionImpl(finalTx, server);
  }
}

// ── parsing helpers ────────────────────────────────────────────────────────

/**
 * Maps a parsed stellar-sdk operation object back to stellar-flow's builder methods.
 * @param builder - The TxBuilder instance to add the operation to
 * @param op - The parsed operation object from tx.operations
 * @throws TxBuilderValidationError if the operation type is not supported
 */
function mapParsedOperation(builder: TxBuilder, op: any): void {
  const mapAsset = (asset: Asset) =>
    asset.isNative() ? 'XLM' : { code: asset.getCode(), issuer: asset.getIssuer() };

  switch (op.type) {
    case 'payment':
      builder.addPayment({
        destination: op.destination,
        asset: mapAsset(op.asset),
        amount: op.amount,
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;

    case 'createAccount':
      builder.addCreateAccount({
        destination: op.destination,
        startingBalance: op.startingBalance,
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;

    case 'changeTrust': {
      const asset =
        op.line instanceof LiquidityPoolAsset
          ? op.line
          : (mapAsset(op.line) as { code: string; issuer: string });
      builder.addChangeTrust({
        asset,
        limit: op.limit,
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;
    }

    case 'manageSellOffer':
      builder.addManageOffer({
        selling: mapAsset(op.selling),
        buying: mapAsset(op.buying),
        amount: op.amount,
        price: op.price,
        offerId: op.offerId,
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;

    case 'manageBuyOffer':
      builder.addManageBuyOffer({
        selling: mapAsset(op.selling),
        buying: mapAsset(op.buying),
        amount: op.buyAmount,
        price: op.price,
        offerId: op.offerId,
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;

    case 'pathPaymentStrictSend':
      builder.addPathPayment({
        destination: op.destination,
        sendAsset: mapAsset(op.sendAsset),
        sendAmount: op.sendAmount,
        destAsset: mapAsset(op.destAsset),
        destAmount: op.destMin,
        path: op.path ? op.path.map(mapAsset) : [],
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;

    case 'setOptions':
      builder.addSetOptions({
        inflationDest: op.inflationDest,
        clearFlags: op.clearFlags,
        setFlags: op.setFlags,
        masterWeight: op.masterWeight,
        lowThreshold: op.lowThreshold,
        medThreshold: op.medThreshold,
        highThreshold: op.highThreshold,
        homeDomain: op.homeDomain,
        signer: op.signer,
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;

    case 'manageData': {
      let value: string | null;
      if (op.value === null || op.value === undefined) {
        value = null;
      } else if (Buffer.isBuffer(op.value)) {
        value = op.value.toString('utf8');
      } else if (typeof op.value === 'string') {
        value = op.value;
      } else {
        throw new TxBuilderValidationError('Invalid manageData value in XDR', 'value', op.value);
      }

      builder.addManageData({
        name: op.name,
        value,
        ...(op.source ? { sourceAccount: op.source } : {}),
      });
      break;
    }

    case 'invokeHostFunction':
      if (op.func && op.func.switch().name === 'hostFunctionTypeInvokeContract') {
        const invokeArgs = op.func.value();
        const contractId = Address.fromScAddress(invokeArgs.contractAddress()).toString();
        const functionName = invokeArgs.functionName().toString('utf8');

        builder.invokeContract({
          contractId,
          functionName,
          args: invokeArgs.args(),
          auth: op.auth,
          ...(op.source ? { sourceAccount: op.source } : {}),
        });
      } else {
        throw new TxBuilderValidationError(
          `Unsupported invokeHostFunction type in fromXDR`,
          'operation',
          op,
        );
      }
      break;

    default:
      throw new TxBuilderValidationError(
        `Unsupported operation type in fromXDR: ${op.type}`,
        'operation',
        op,
      );
  }
}
