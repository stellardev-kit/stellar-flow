import {
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  SorobanDataBuilder,
  xdr,
  Address,
  Asset,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
} from '@stellar/stellar-sdk';
import { TxBuilder, BuiltTransaction } from '../src';
import { TxBuilderValidationError } from '../src/errors';
import type { ChangeTrustParams, InspectableBuiltTransaction, SubmitResult } from '../src';

// ── fixtures ──────────────────────────────────────────────────────────────
const SOURCE = Keypair.random();
const DEST = Keypair.random().publicKey();

// Mock Horizon — no network calls in unit tests
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  // We need SOURCE's public key at mock-setup time, so generate one here
  // and re-use it as the mocked account id.
  const sourceKp = actual.Keypair.random();

  const mockAccount = new actual.Account(sourceKp.publicKey(), '100');

  return {
    ...actual,
    _mockSourceKp: sourceKp, // exposed so tests can reference it
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: jest.fn().mockResolvedValue(mockAccount),
        submitTransaction: jest.fn().mockResolvedValue({
          hash: 'abc123',
          ledger: 1000,
          successful: true,
          result_xdr: 'AAAA',
        }),
      })),
    },
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        prepareTransaction: jest.fn().mockImplementation(async (tx: any) => tx),
      })),
    },
  };
});

// Pull the mock keypair so we can build valid TxBuilders against it
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _mockSourceKp: MOCK_SOURCE } = require('@stellar/stellar-sdk') as {
  _mockSourceKp: Keypair;
};

function builder() {
  return TxBuilder.for(MOCK_SOURCE, { network: 'testnet' });
}

function createAddressAuthEntry(
  contractId: string = DEST,
  subContractId?: string,
): xdr.SorobanAuthorizationEntry {
  const subInvocations: xdr.SorobanAuthorizedInvocation[] = [];
  if (subContractId) {
    subInvocations.push(
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(subContractId).toScAddress(),
            functionName: 'sub_fn',
            args: [xdr.ScVal.scvString('sub_arg')],
          }),
        ),
        subInvocations: [],
      }),
    );
  }

  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: 'root_fn',
        args: [xdr.ScVal.scvU32(42)],
      }),
    ),
    subInvocations,
  });

  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: new Address(DEST).toScAddress(),
      nonce: xdr.Int64.fromString('12345'),
      signatureExpirationLedger: 99999,
      signature: xdr.ScVal.scvBytes(Buffer.from('test_signature')),
    }),
  );

  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation,
  });
}

function createSourceAccountAuthEntry(contractId: string = DEST): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contractId).toScAddress(),
          functionName: 'source_fn',
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('TxBuilder.for()', () => {
  it('returns a TxBuilder instance', () => {
    expect(builder()).toBeDefined();
  });
});

describe('addPayment()', () => {
  it('accepts a valid XLM payment and returns this for chaining', () => {
    const b = builder();
    expect(b.addPayment({ destination: DEST, amount: '10', asset: 'XLM' })).toBe(b);
  });

  it('accepts a custom asset payment', () => {
    expect(() =>
      builder().addPayment({
        destination: DEST,
        amount: '50',
        asset: { code: 'USDC', issuer: DEST },
      }),
    ).not.toThrow();
  });

  it('throws on invalid destination address', () => {
    expect(() =>
      builder().addPayment({ destination: 'not-an-address', amount: '10', asset: 'XLM' }),
    ).toThrow('Invalid Stellar address');
  });

  it('throws on empty destination address', () => {
    expect(() => builder().addPayment({ destination: '', amount: '10', asset: 'XLM' })).toThrow(
      'must be a non-empty string',
    );
  });

  it('throws on zero amount', () => {
    expect(() => builder().addPayment({ destination: DEST, amount: '0', asset: 'XLM' })).toThrow(
      'must be greater than 0',
    );
  });

  it('throws on negative amount', () => {
    expect(() => builder().addPayment({ destination: DEST, amount: '-5', asset: 'XLM' })).toThrow(
      'must be greater than 0',
    );
  });

  it('throws on empty amount', () => {
    expect(() => builder().addPayment({ destination: DEST, amount: '', asset: 'XLM' })).toThrow(
      'must be a non-empty string',
    );
  });

  it('throws on invalid amount string', () => {
    expect(() =>
      builder().addPayment({ destination: DEST, amount: 'not-a-number', asset: 'XLM' }),
    ).toThrow('is not a valid number');
  });

  it('throws on custom asset with empty code', () => {
    expect(() =>
      builder().addPayment({ destination: DEST, amount: '10', asset: { code: '', issuer: DEST } }),
    ).toThrow('Asset code must be a non-empty string');
  });

  it('throws on custom asset with empty issuer', () => {
    expect(() =>
      builder().addPayment({
        destination: DEST,
        amount: '10',
        asset: { code: 'USDC', issuer: '' },
      }),
    ).toThrow('Asset issuer must be a non-empty string');
  });
});

describe('addCreateAccount()', () => {
  it('chains correctly with a valid address and balance', () => {
    const b = builder();
    expect(b.addCreateAccount({ destination: DEST, startingBalance: '2' })).toBe(b);
  });

  it('throws on invalid address', () => {
    expect(() => builder().addCreateAccount({ destination: 'bad', startingBalance: '2' })).toThrow(
      'Invalid Stellar address',
    );
  });

  it('throws on zero startingBalance', () => {
    expect(() => builder().addCreateAccount({ destination: DEST, startingBalance: '0' })).toThrow(
      'Invalid amount',
    );
  });
});

describe('addChangeTrust()', () => {
  it('chains correctly', () => {
    const b = builder();
    expect(b.addChangeTrust({ asset: { code: 'USDC', issuer: DEST } })).toBe(b);
  });

  it('accepts an optional limit', () => {
    expect(() =>
      builder().addChangeTrust({ asset: { code: 'USDC', issuer: DEST }, limit: '1000' }),
    ).not.toThrow();
  });

  it('throws friendly error on invalid issuer address', () => {
    expect(() =>
      builder().addChangeTrust({ asset: { code: 'USDC', issuer: 'not-a-valid-address' } }),
    ).toThrow('Invalid asset:');
  });

  it('accepts a LiquidityPoolAsset directly', () => {
    const lpAsset = new LiquidityPoolAsset(
      Asset.native(),
      new Asset('USDC', DEST),
      LiquidityPoolFeeV18,
    );
    const b = builder();
    expect(b.addChangeTrust({ asset: lpAsset, limit: '1000' })).toBe(b);
    const desc = b.describe();
    expect(desc.operations[0].type).toBe('changeTrust');
    expect((desc.operations[0].params as ChangeTrustParams).asset).toBe(lpAsset);
  });

  it('validates custom sourceAccount', () => {
    const customSource = Keypair.random().publicKey();
    const b = builder();
    expect(
      b.addChangeTrust({
        asset: { code: 'USDC', issuer: DEST },
        sourceAccount: customSource,
      }),
    ).toBe(b);
    expect((b.describe().operations[0].params as ChangeTrustParams).sourceAccount).toBe(
      customSource,
    );
  });

  it('rejects invalid sourceAccount and does not mutate builder operations', () => {
    const b = builder();
    expect(() =>
      b.addChangeTrust({
        asset: { code: 'USDC', issuer: DEST },
        sourceAccount: 'invalid-public-key',
      }),
    ).toThrow(TxBuilderValidationError);
    expect(b.describe().operations).toHaveLength(0);
  });
});

describe('addManageOffer()', () => {
  it('chains correctly with XLM to custom asset', () => {
    const b = builder();
    expect(
      b.addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '0.5',
      }),
    ).toBe(b);
  });

  it('chains correctly with custom asset to XLM', () => {
    const b = builder();
    expect(
      b.addManageOffer({
        selling: { code: 'USDC', issuer: DEST },
        buying: 'XLM',
        amount: '50',
        price: '2.0',
      }),
    ).toBe(b);
  });

  it('accepts price as fraction object', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: 2 },
      }),
    ).not.toThrow();
  });

  it('accepts optional offerId', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '0.5',
        offerId: '12345',
      }),
    ).not.toThrow();
  });

  it('throws on invalid amount', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '0',
        price: '0.5',
      }),
    ).toThrow('must be greater than 0');
  });

  it('throws on invalid price string', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: 'not-a-number',
      }),
    ).toThrow('Invalid price');
  });

  it('throws on negative price', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '-1.5',
      }),
    ).toThrow('must be a positive number');
  });

  it('throws on invalid price fraction', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: -1, d: 2 },
      }),
    ).toThrow('numerator and denominator must be positive');
  });

  it('correctly resolves decimal price 0.57 without floating point truncation', async () => {
    const b = builder().addManageOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '0.57',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageSellOfferOp();
    expect(op.price().n()).toBe(57);
    expect(op.price().d()).toBe(100);
  });

  it('correctly handles large price 60000 without int32 overflow', async () => {
    const b = builder().addManageOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '60000',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageSellOfferOp();
    expect(op.price().n()).toBe(60000);
    expect(op.price().d()).toBe(1);
  });

  it('correctly handles small price 0.00000001 without truncation to zero', async () => {
    const b = builder().addManageOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '0.00000001',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageSellOfferOp();
    expect(op.price().n()).toBe(1);
    expect(op.price().d()).toBe(100000000);
  });

  it('correctly handles price near max representable ratio 2147483647', async () => {
    const b = builder().addManageOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '2147483647',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageSellOfferOp();
    expect(op.price().n()).toBe(2147483647);
    expect(op.price().d()).toBe(1);
  });

  it('throws on string price exceeding max representable ratio', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '2147483648',
      }),
    ).toThrow('cannot be represented as a Stellar price');
  });

  it('throws on non-integer price fraction', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1.5, d: 2 },
      }),
    ).toThrow('numerator and denominator must be integers');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 2, d: 1.5 },
      }),
    ).toThrow('numerator and denominator must be integers');
  });

  it('throws on price fraction with zero numerator or denominator', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 0, d: 1 },
      }),
    ).toThrow('numerator and denominator must be positive');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: 0 },
      }),
    ).toThrow('numerator and denominator must be positive');
  });

  it('throws on price fraction exceeding signed 32-bit int limit', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 2147483648, d: 1 },
      }),
    ).toThrow('must not exceed 2147483647');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: 2147483648 },
      }),
    ).toThrow('must not exceed 2147483647');
  });

  it('correctly handles exponential string price notation', async () => {
    const b = builder().addManageOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '1e-8',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageSellOfferOp();
    expect(op.price().n()).toBe(1);
    expect(op.price().d()).toBe(100000000);
  });

  it('throws on unrepresentable extreme exponential string prices', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '1e-12',
      }),
    ).toThrow('cannot be represented as a Stellar price');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '1e12',
      }),
    ).toThrow('cannot be represented as a Stellar price');
  });

  it('throws on whitespace-only string price', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '   ',
      }),
    ).toThrow('must be a positive number');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '\t\n',
      }),
    ).toThrow('must be a positive number');
  });

  it('throws on hexadecimal, binary, and octal price strings', () => {
    const invalidFormats = [
      '0x10',
      '0X10',
      '0x1a',
      '-0x10',
      '+0x10',
      '0x0',
      '0b10',
      '0B10',
      '-0b10',
      '0b0',
      '0o10',
      '0O10',
    ];
    for (const price of invalidFormats) {
      expect(() =>
        builder().addManageOffer({
          selling: 'XLM',
          buying: { code: 'USDC', issuer: DEST },
          amount: '100',
          price,
        }),
      ).toThrow('must be a positive number');
    }
  });

  it('throws on zero price string', () => {
    const zeroPrices = ['0', '0.0', '-0', '+0', '.0', '0.000', '0e0', '0e5'];
    for (const price of zeroPrices) {
      expect(() =>
        builder().addManageOffer({
          selling: 'XLM',
          buying: { code: 'USDC', issuer: DEST },
          amount: '100',
          price,
        }),
      ).toThrow('must be a positive number');
    }
  });

  it('throws on non-finite price strings', () => {
    const nonFinitePrices = ['Infinity', '-Infinity', '+Infinity', 'NaN'];
    for (const price of nonFinitePrices) {
      expect(() =>
        builder().addManageOffer({
          selling: 'XLM',
          buying: { code: 'USDC', issuer: DEST },
          amount: '100',
          price,
        }),
      ).toThrow('must be a positive number');
    }
  });

  it('throws on malformed or non-finite price fraction objects', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1 } as any,
      }),
    ).toThrow('must be a string or {n, d} object');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: NaN, d: 1 } as any,
      }),
    ).toThrow('numerator and denominator must be positive');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: Infinity } as any,
      }),
    ).toThrow('numerator and denominator must be positive');
  });

  it('throws on null or non-string/non-object price values', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: null as any,
      }),
    ).toThrow('must be a string or {n, d} object');

    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: 123 as any,
      }),
    ).toThrow('must be a string or {n, d} object');
  });

  it('throws on empty selling asset code', () => {
    expect(() =>
      builder().addManageOffer({
        selling: { code: '', issuer: DEST },
        buying: 'XLM',
        amount: '100',
        price: '0.5',
      }),
    ).toThrow('Asset code must be a non-empty string');
  });

  it('throws on empty buying asset code', () => {
    expect(() =>
      builder().addManageOffer({
        selling: 'XLM',
        buying: { code: '', issuer: DEST },
        amount: '100',
        price: '0.5',
      }),
    ).toThrow('Asset code must be a non-empty string');
  });
});

describe('addManageBuyOffer()', () => {
  it('chains correctly with XLM to custom asset', () => {
    const b = builder();
    expect(
      b.addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '0.5',
      }),
    ).toBe(b);
  });

  it('chains correctly with custom asset to XLM', () => {
    const b = builder();
    expect(
      b.addManageBuyOffer({
        selling: { code: 'USDC', issuer: DEST },
        buying: 'XLM',
        amount: '50',
        price: '2.0',
      }),
    ).toBe(b);
  });

  it('accepts price as fraction object', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: 2 },
      }),
    ).not.toThrow();
  });

  it('accepts optional offerId', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '0.5',
        offerId: '12345',
      }),
    ).not.toThrow();
  });

  it('throws on invalid amount', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '0',
        price: '0.5',
      }),
    ).toThrow('must be greater than 0');
  });

  it('throws on invalid price string', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: 'not-a-number',
      }),
    ).toThrow('Invalid price');
  });

  it('throws on negative price', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '-1.5',
      }),
    ).toThrow('must be a positive number');
  });

  it('throws on invalid price fraction', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: -1, d: 2 },
      }),
    ).toThrow('numerator and denominator must be positive');
  });

  it('correctly resolves decimal price 0.57 without floating point truncation', async () => {
    const b = builder().addManageBuyOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '0.57',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageBuyOfferOp();
    expect(op.price().n()).toBe(57);
    expect(op.price().d()).toBe(100);
  });

  it('correctly handles large price 60000 without int32 overflow', async () => {
    const b = builder().addManageBuyOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '60000',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageBuyOfferOp();
    expect(op.price().n()).toBe(60000);
    expect(op.price().d()).toBe(1);
  });

  it('correctly handles small price 0.00000001 without truncation to zero', async () => {
    const b = builder().addManageBuyOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '0.00000001',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageBuyOfferOp();
    expect(op.price().n()).toBe(1);
    expect(op.price().d()).toBe(100000000);
  });

  it('correctly handles price near max representable ratio 2147483647', async () => {
    const b = builder().addManageBuyOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '2147483647',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageBuyOfferOp();
    expect(op.price().n()).toBe(2147483647);
    expect(op.price().d()).toBe(1);
  });

  it('throws on string price exceeding max representable ratio', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '2147483648',
      }),
    ).toThrow('cannot be represented as a Stellar price');
  });

  it('throws on non-integer price fraction', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1.5, d: 2 },
      }),
    ).toThrow('numerator and denominator must be integers');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 2, d: 1.5 },
      }),
    ).toThrow('numerator and denominator must be integers');
  });

  it('throws on price fraction with zero numerator or denominator', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 0, d: 1 },
      }),
    ).toThrow('numerator and denominator must be positive');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: 0 },
      }),
    ).toThrow('numerator and denominator must be positive');
  });

  it('throws on price fraction exceeding signed 32-bit int limit', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 2147483648, d: 1 },
      }),
    ).toThrow('must not exceed 2147483647');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: 2147483648 },
      }),
    ).toThrow('must not exceed 2147483647');
  });

  it('correctly handles exponential string price notation', async () => {
    const b = builder().addManageBuyOffer({
      selling: 'XLM',
      buying: { code: 'USDC', issuer: DEST },
      amount: '100',
      price: '1e-8',
    });
    const built = await b.build();
    expect(built.toXDR()).toBeTruthy();
    const op = (b as any).operations[0].body().manageBuyOfferOp();
    expect(op.price().n()).toBe(1);
    expect(op.price().d()).toBe(100000000);
  });

  it('throws on unrepresentable extreme exponential string prices', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '1e-12',
      }),
    ).toThrow('cannot be represented as a Stellar price');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '1e12',
      }),
    ).toThrow('cannot be represented as a Stellar price');
  });

  it('throws on whitespace-only string price', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '   ',
      }),
    ).toThrow('must be a positive number');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '\t\n',
      }),
    ).toThrow('must be a positive number');
  });

  it('throws on hexadecimal, binary, and octal price strings', () => {
    const invalidFormats = [
      '0x10',
      '0X10',
      '0x1a',
      '-0x10',
      '+0x10',
      '0x0',
      '0b10',
      '0B10',
      '-0b10',
      '0b0',
      '0o10',
      '0O10',
    ];
    for (const price of invalidFormats) {
      expect(() =>
        builder().addManageBuyOffer({
          selling: 'XLM',
          buying: { code: 'USDC', issuer: DEST },
          amount: '100',
          price,
        }),
      ).toThrow('must be a positive number');
    }
  });

  it('throws on zero price string', () => {
    const zeroPrices = ['0', '0.0', '-0', '+0', '.0', '0.000', '0e0', '0e5'];
    for (const price of zeroPrices) {
      expect(() =>
        builder().addManageBuyOffer({
          selling: 'XLM',
          buying: { code: 'USDC', issuer: DEST },
          amount: '100',
          price,
        }),
      ).toThrow('must be a positive number');
    }
  });

  it('throws on non-finite price strings', () => {
    const nonFinitePrices = ['Infinity', '-Infinity', '+Infinity', 'NaN'];
    for (const price of nonFinitePrices) {
      expect(() =>
        builder().addManageBuyOffer({
          selling: 'XLM',
          buying: { code: 'USDC', issuer: DEST },
          amount: '100',
          price,
        }),
      ).toThrow('must be a positive number');
    }
  });

  it('throws on malformed or non-finite price fraction objects', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1 } as any,
      }),
    ).toThrow('must be a string or {n, d} object');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: NaN, d: 1 } as any,
      }),
    ).toThrow('numerator and denominator must be positive');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: { n: 1, d: Infinity } as any,
      }),
    ).toThrow('numerator and denominator must be positive');
  });

  it('throws on null or non-string/non-object price values', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: null as any,
      }),
    ).toThrow('must be a string or {n, d} object');

    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: 123 as any,
      }),
    ).toThrow('must be a string or {n, d} object');
  });

  it('throws on empty selling asset code', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: { code: '', issuer: DEST },
        buying: 'XLM',
        amount: '100',
        price: '0.5',
      }),
    ).toThrow('Asset code must be a non-empty string');
  });

  it('throws on empty buying asset code', () => {
    expect(() =>
      builder().addManageBuyOffer({
        selling: 'XLM',
        buying: { code: '', issuer: DEST },
        amount: '100',
        price: '0.5',
      }),
    ).toThrow('Asset code must be a non-empty string');
  });
});

describe('addPathPayment()', () => {
  it('chains correctly with XLM to custom asset', () => {
    const b = builder();
    expect(
      b.addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '100',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '50',
      }),
    ).toBe(b);
  });

  it('chains correctly with custom asset to XLM', () => {
    const b = builder();
    expect(
      b.addPathPayment({
        destination: DEST,
        sendAsset: { code: 'USDC', issuer: DEST },
        sendAmount: '50',
        destAsset: 'XLM',
        destAmount: '100',
      }),
    ).toBe(b);
  });

  it('accepts optional path array', () => {
    expect(() =>
      builder().addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '100',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '50',
        path: [{ code: 'EUR', issuer: DEST }],
      }),
    ).not.toThrow();
  });

  it('accepts empty path array', () => {
    expect(() =>
      builder().addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '100',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '50',
        path: [],
      }),
    ).not.toThrow();
  });

  it('throws on invalid destination address', () => {
    expect(() =>
      builder().addPathPayment({
        destination: 'not-an-address',
        sendAsset: 'XLM',
        sendAmount: '100',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '50',
      }),
    ).toThrow('Invalid Stellar address');
  });

  it('throws on invalid send amount', () => {
    expect(() =>
      builder().addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '0',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '50',
      }),
    ).toThrow('must be greater than 0');
  });

  it('throws on invalid destination amount', () => {
    expect(() =>
      builder().addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '100',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '0',
      }),
    ).toThrow('must be greater than 0');
  });

  it('throws on empty send asset code', () => {
    expect(() =>
      builder().addPathPayment({
        destination: DEST,
        sendAsset: { code: '', issuer: DEST },
        sendAmount: '100',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '50',
      }),
    ).toThrow('Asset code must be a non-empty string');
  });

  it('throws on empty dest asset code', () => {
    expect(() =>
      builder().addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '100',
        destAsset: { code: '', issuer: DEST },
        destAmount: '50',
      }),
    ).toThrow('Asset code must be a non-empty string');
  });

  it('throws on invalid path asset code', () => {
    expect(() =>
      builder().addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '100',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '50',
        path: [{ code: '', issuer: DEST }],
      }),
    ).toThrow('Asset code must be a non-empty string');
  });
});

describe('addSetOptions()', () => {
  it('chains correctly with inflation destination', () => {
    const b = builder();
    expect(b.addSetOptions({ inflationDest: DEST })).toBe(b);
  });

  it('chains correctly with clear flags', () => {
    const b = builder();
    expect(b.addSetOptions({ clearFlags: 1 })).toBe(b);
  });

  it('chains correctly with set flags', () => {
    const b = builder();
    expect(b.addSetOptions({ setFlags: 1 })).toBe(b);
  });

  it('chains correctly with master weight', () => {
    const b = builder();
    expect(b.addSetOptions({ masterWeight: 100 })).toBe(b);
  });

  it('chains correctly with thresholds', () => {
    const b = builder();
    expect(b.addSetOptions({ lowThreshold: 1, medThreshold: 2, highThreshold: 3 })).toBe(b);
  });

  it('chains correctly with home domain', () => {
    const b = builder();
    expect(b.addSetOptions({ homeDomain: 'example.com' })).toBe(b);
  });

  it('chains correctly with ed25519 signer', () => {
    const b = builder();
    expect(
      b.addSetOptions({
        signer: { ed25519PublicKey: DEST, weight: 1 },
      }),
    ).toBe(b);
  });

  it('chains correctly with sha256 signer', () => {
    const b = builder();
    expect(
      b.addSetOptions({
        signer: { sha256Hash: 'a'.repeat(64), weight: 1 },
      }),
    ).toBe(b);
  });

  it('chains correctly with preAuthTx signer', () => {
    const b = builder();
    expect(
      b.addSetOptions({
        signer: { preAuthTx: 'b'.repeat(64), weight: 1 },
      }),
    ).toBe(b);
  });

  it('throws on invalid inflation destination', () => {
    expect(() => builder().addSetOptions({ inflationDest: 'not-an-address' })).toThrow(
      'Invalid Stellar address',
    );
  });

  it('throws on master weight out of range', () => {
    expect(() => builder().addSetOptions({ masterWeight: 256 })).toThrow(
      'must be between 0 and 255',
    );
  });

  it('throws on low threshold out of range', () => {
    expect(() => builder().addSetOptions({ lowThreshold: -1 })).toThrow(
      'must be between 0 and 255',
    );
  });

  it('throws on home domain too long', () => {
    expect(() => builder().addSetOptions({ homeDomain: 'a'.repeat(33) })).toThrow(
      '32 characters or fewer',
    );
  });

  it('throws on signer weight out of range', () => {
    expect(() =>
      builder().addSetOptions({
        signer: { ed25519PublicKey: DEST, weight: 256 },
      }),
    ).toThrow('must be between 0 and 255');
  });

  it('throws on signer without type', () => {
    expect(() =>
      builder().addSetOptions({
        signer: { weight: 1 } as any,
      }),
    ).toThrow('must specify one of');
  });

  it('throws on invalid signer public key', () => {
    expect(() =>
      builder().addSetOptions({
        signer: { ed25519PublicKey: 'not-an-address', weight: 1 },
      }),
    ).toThrow('Invalid Stellar address');
  });
});

describe('addManageData()', () => {
  it('chains correctly with name and value', () => {
    const b = builder();
    expect(b.addManageData({ name: 'key', value: 'value' })).toBe(b);
  });

  it('chains correctly with explicit null value (deletes data)', () => {
    const b = builder();
    expect(b.addManageData({ name: 'key', value: null })).toBe(b);
  });

  it('chains correctly with omitted value (deletes data)', () => {
    const b = builder();
    expect(b.addManageData({ name: 'key' })).toBe(b);
  });

  it('chains correctly with empty string value (stores empty value)', () => {
    const b = builder();
    expect(b.addManageData({ name: 'key', value: '' })).toBe(b);
  });

  it('accepts name at 64-byte limit', () => {
    expect(() => builder().addManageData({ name: 'a'.repeat(64), value: 'value' })).not.toThrow();
  });

  it('accepts value at 64-byte limit', () => {
    expect(() => builder().addManageData({ name: 'key', value: 'b'.repeat(64) })).not.toThrow();
  });

  it('throws on empty name', () => {
    expect(() => builder().addManageData({ name: '', value: 'value' })).toThrow(
      'must be a non-empty string',
    );
  });

  it('throws on name exceeding 64 bytes', () => {
    expect(() => builder().addManageData({ name: 'a'.repeat(65), value: 'value' })).toThrow(
      'exceeds 64-byte limit',
    );
  });

  it('throws on value exceeding 64 bytes', () => {
    expect(() => builder().addManageData({ name: 'key', value: 'b'.repeat(65) })).toThrow(
      'exceeds 64-byte limit',
    );
  });

  it('throws on non-string value', () => {
    expect(() => builder().addManageData({ name: 'key', value: 123 as any })).toThrow(
      'must be a string',
    );
  });

  it('produces a null XDR data value when value is explicitly null', async () => {
    const b = builder().addManageData({ name: 'my-data', value: null });
    const built = await b.build();
    const tx = new Transaction(built.toXDR(), Networks.TESTNET);
    const op = tx.operations[0] as any;
    expect(tx.operations).toHaveLength(1);
    expect(op.type).toBe('manageData');
    expect(op.name).toBe('my-data');
    expect(op.value).toBeUndefined();

    const env = tx.toEnvelope();
    const opXdr = env.v1().tx().operations()[0].body().manageDataOp();
    expect(opXdr.dataName().toString()).toBe('my-data');
    expect(opXdr.dataValue()).toBeUndefined();

    const internalOp = (b as any).operations[0].body().manageDataOp();
    expect(internalOp.dataValue()).toBeNull();
  });

  it('produces a null XDR data value when value is omitted', async () => {
    const b = builder().addManageData({ name: 'my-data' });
    const built = await b.build();
    const tx = new Transaction(built.toXDR(), Networks.TESTNET);
    const op = tx.operations[0] as any;
    expect(tx.operations).toHaveLength(1);
    expect(op.type).toBe('manageData');
    expect(op.name).toBe('my-data');
    expect(op.value).toBeUndefined();

    const env = tx.toEnvelope();
    const opXdr = env.v1().tx().operations()[0].body().manageDataOp();
    expect(opXdr.dataName().toString()).toBe('my-data');
    expect(opXdr.dataValue()).toBeUndefined();

    const internalOp = (b as any).operations[0].body().manageDataOp();
    expect(internalOp.dataValue()).toBeNull();
  });

  it('produces a non-null, zero-length Buffer when value is an empty string', async () => {
    const b = builder().addManageData({ name: 'my-data', value: '' });
    const built = await b.build();
    const tx = new Transaction(built.toXDR(), Networks.TESTNET);
    const op = tx.operations[0] as any;
    expect(tx.operations).toHaveLength(1);
    expect(op.type).toBe('manageData');
    expect(op.name).toBe('my-data');
    expect(Buffer.isBuffer(op.value)).toBe(true);
    expect((op.value as Buffer).length).toBe(0);

    const env = tx.toEnvelope();
    const opXdr = env.v1().tx().operations()[0].body().manageDataOp();
    expect(Buffer.isBuffer(opXdr.dataValue())).toBe(true);
    expect(opXdr.dataValue()).not.toBeNull();
    expect((opXdr.dataValue() as Buffer).length).toBe(0);

    const internalOp = (b as any).operations[0].body().manageDataOp();
    expect(Buffer.isBuffer(internalOp.dataValue())).toBe(true);
    expect(internalOp.dataValue().length).toBe(0);
  });

  it('preserves bytes when value is a normal string', async () => {
    const b = builder().addManageData({ name: 'my-data', value: 'hello stellar' });
    const built = await b.build();
    const tx = new Transaction(built.toXDR(), Networks.TESTNET);
    const op = tx.operations[0] as any;
    expect(tx.operations).toHaveLength(1);
    expect(op.type).toBe('manageData');
    expect(op.name).toBe('my-data');
    expect(Buffer.isBuffer(op.value)).toBe(true);
    expect((op.value as Buffer).toString('utf8')).toBe('hello stellar');

    const env = tx.toEnvelope();
    const opXdr = env.v1().tx().operations()[0].body().manageDataOp();
    expect(Buffer.isBuffer(opXdr.dataValue())).toBe(true);
    expect((opXdr.dataValue() as Buffer).toString('utf8')).toBe('hello stellar');
  });

  it('rejects invalid value types without appending an operation or descriptor', () => {
    const b = builder();
    expect(() => b.addManageData({ name: 'key', value: 123 as any })).toThrow(
      TxBuilderValidationError,
    );
    expect(() => b.addManageData({ name: 'key', value: true as any })).toThrow(
      TxBuilderValidationError,
    );
    expect(() => b.addManageData({ name: 'key', value: {} as any })).toThrow(
      TxBuilderValidationError,
    );
    expect(() => b.addManageData({ name: 'key', value: Buffer.from('hello') as any })).toThrow(
      TxBuilderValidationError,
    );
    expect((b as any).operations).toHaveLength(0);
    expect(b.describe().operations).toHaveLength(0);
  });

  it('rejects invalid name or excessive length without appending an operation or descriptor', () => {
    const b = builder();
    expect(() => b.addManageData({ name: '', value: 'test' })).toThrow(TxBuilderValidationError);
    expect(() => b.addManageData({ name: 'a'.repeat(65), value: 'test' })).toThrow(
      TxBuilderValidationError,
    );
    expect(() => b.addManageData({ name: 'key', value: 'b'.repeat(65) })).toThrow(
      TxBuilderValidationError,
    );
    expect((b as any).operations).toHaveLength(0);
    expect(b.describe().operations).toHaveLength(0);
  });

  it('restores a ManageData deletion without throwing in fromXDR()', async () => {
    const originalExplicitNull = builder().addManageData({ name: 'deletedKey1', value: null });
    const originalOmitted = builder().addManageData({ name: 'deletedKey2' });

    const built1 = await originalExplicitNull.build();
    const built2 = await originalOmitted.build();

    let restored1!: TxBuilder;
    let restored2!: TxBuilder;
    expect(() => {
      restored1 = TxBuilder.fromXDR(built1.toXDR(), { network: 'testnet' });
      restored2 = TxBuilder.fromXDR(built2.toXDR(), { network: 'testnet' });
    }).not.toThrow();

    const desc1 = restored1.describe();
    expect(desc1.operations).toHaveLength(1);
    expect(desc1.operations[0].type).toBe('manageData');
    expect((desc1.operations[0].params as any).name).toBe('deletedKey1');
    expect((desc1.operations[0].params as any).value).toBeNull();

    const desc2 = restored2.describe();
    expect(desc2.operations).toHaveLength(1);
    expect(desc2.operations[0].type).toBe('manageData');
    expect((desc2.operations[0].params as any).name).toBe('deletedKey2');
    expect((desc2.operations[0].params as any).value).toBeNull();
  });

  it('throws TxBuilderValidationError in fromXDR() when manageData value is invalid type', async () => {
    const built = await builder().addManageData({ name: 'k', value: 'v' }).build();
    const xdr = built.toXDR();
    const spy = jest
      .spyOn(Transaction.prototype, 'operations', 'get')
      .mockReturnValue([{ type: 'manageData', name: 'corruptKey', value: 12345 } as any]);
    try {
      expect(() => {
        TxBuilder.fromXDR(xdr, { network: 'testnet' });
      }).toThrow(TxBuilderValidationError);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves the distinction between deletion and an empty value in fromXDR()', async () => {
    const bDel = builder().addManageData({ name: 'delKey', value: null });
    const bEmpty = builder().addManageData({ name: 'emptyKey', value: '' });

    const builtDel = await bDel.build();
    const builtEmpty = await bEmpty.build();

    const restoredDel = TxBuilder.fromXDR(builtDel.toXDR(), { network: 'testnet' });
    const restoredEmpty = TxBuilder.fromXDR(builtEmpty.toXDR(), { network: 'testnet' });

    const descDel = restoredDel.describe();
    const descEmpty = restoredEmpty.describe();

    expect(descDel.operations[0].params).toEqual({ name: 'delKey', value: null });
    expect(descEmpty.operations[0].params).toEqual({ name: 'emptyKey', value: '' });

    const internalDelOp = (restoredDel as any).operations[0].body().manageDataOp();
    expect(internalDelOp.dataValue()).toBeNull();

    const internalEmptyOp = (restoredEmpty as any).operations[0].body().manageDataOp();
    expect(Buffer.isBuffer(internalEmptyOp.dataValue())).toBe(true);
    expect(internalEmptyOp.dataValue().length).toBe(0);
  });

  it('survives an XDR round-trip for ManageData operations (deletion, empty, and normal)', async () => {
    const testCases: {
      name: string;
      value?: string | null;
      expectedType: 'deletion' | 'empty' | 'normal';
    }[] = [
      { name: 'roundTripDelNull', value: null, expectedType: 'deletion' },
      { name: 'roundTripDelOmitted', expectedType: 'deletion' },
      { name: 'roundTripEmpty', value: '', expectedType: 'empty' },
      { name: 'roundTripNormal', value: 'active_session_token', expectedType: 'normal' },
    ];

    for (const tc of testCases) {
      const original = builder().addManageData(tc);
      const builtOriginal = await original.build();
      const xdrOriginal = builtOriginal.toXDR();

      const restored = TxBuilder.fromXDR(xdrOriginal, { network: 'testnet' });
      const builtRestored = await restored.build();
      const xdrRestored = builtRestored.toXDR();

      const tx1 = new Transaction(xdrOriginal, Networks.TESTNET);
      const tx2 = new Transaction(xdrRestored, Networks.TESTNET);

      // Transaction-level fields preserved across fromXDR
      expect(tx2.source).toBe(tx1.source);
      expect(tx2.fee).toBe(tx1.fee);
      expect(tx2.operations).toHaveLength(1);

      const op1 = tx1.operations[0] as any;
      const op2 = tx2.operations[0] as any;
      expect(op2.type).toBe('manageData');
      expect(op2.name).toBe(tc.name);

      const opXdr1 = tx1.toEnvelope().v1().tx().operations()[0].body().manageDataOp();
      const opXdr2 = tx2.toEnvelope().v1().tx().operations()[0].body().manageDataOp();
      expect(opXdr2.dataName().toString()).toBe(opXdr1.dataName().toString());

      if (tc.expectedType === 'deletion') {
        // Null pointer in XDR (undefined in JS XDR representation)
        expect(op1.value).toBeUndefined();
        expect(op2.value).toBeUndefined();
        expect(opXdr1.dataValue()).toBeUndefined();
        expect(opXdr2.dataValue()).toBeUndefined();
        expect((restored.describe().operations[0].params as any).value).toBeNull();
      } else if (tc.expectedType === 'empty') {
        // Non-null zero-length buffer in XDR
        expect(Buffer.isBuffer(op1.value)).toBe(true);
        expect(Buffer.isBuffer(op2.value)).toBe(true);
        expect(op1.value.length).toBe(0);
        expect(op2.value.length).toBe(0);
        expect(Buffer.isBuffer(opXdr1.dataValue())).toBe(true);
        expect(Buffer.isBuffer(opXdr2.dataValue())).toBe(true);
        expect((opXdr1.dataValue() as Buffer).length).toBe(0);
        expect((opXdr2.dataValue() as Buffer).length).toBe(0);
        expect((restored.describe().operations[0].params as any).value).toBe('');
      } else {
        // Preserves bytes for normal string
        expect(Buffer.isBuffer(op1.value)).toBe(true);
        expect(Buffer.isBuffer(op2.value)).toBe(true);
        expect(op1.value.toString('utf8')).toBe(tc.value);
        expect(op2.value.toString('utf8')).toBe(tc.value);
        expect(Buffer.isBuffer(opXdr1.dataValue())).toBe(true);
        expect(Buffer.isBuffer(opXdr2.dataValue())).toBe(true);
        expect((opXdr1.dataValue() as Buffer).toString('utf8')).toBe(tc.value);
        expect((opXdr2.dataValue() as Buffer).toString('utf8')).toBe(tc.value);
        expect((restored.describe().operations[0].params as any).value).toBe(tc.value);
      }
    }
  });

  it('handles multiple ManageData operations in the same transaction correctly', async () => {
    const original = builder()
      .addManageData({ name: 'createKey', value: 'hello' })
      .addManageData({ name: 'emptyKey', value: '' })
      .addManageData({ name: 'deleteNullKey', value: null })
      .addManageData({ name: 'deleteOmittedKey' });

    const built = await original.build();
    const xdr = built.toXDR();

    const restored = TxBuilder.fromXDR(xdr, { network: 'testnet' });
    const desc = restored.describe();

    expect(desc.operations).toHaveLength(4);
    expect(desc.operations[0].params).toEqual({ name: 'createKey', value: 'hello' });
    expect(desc.operations[1].params).toEqual({ name: 'emptyKey', value: '' });
    expect(desc.operations[2].params).toEqual({ name: 'deleteNullKey', value: null });
    expect(desc.operations[3].params).toEqual({ name: 'deleteOmittedKey', value: null });

    const restoredBuilt = await restored.build();
    const tx = new Transaction(restoredBuilt.toXDR(), Networks.TESTNET);
    const ops = tx.operations as any[];
    expect(ops).toHaveLength(4);

    expect(ops[0].value.toString('utf8')).toBe('hello');
    expect(ops[1].value.length).toBe(0);
    expect(ops[2].value).toBeUndefined();
    expect(ops[3].value).toBeUndefined();
  });
});

describe('invokeContract()', () => {
  it('chains correctly with valid inputs', () => {
    const b = builder();
    expect(
      b.invokeContract({
        contractId: DEST,
        functionName: 'hello',
      }),
    ).toBe(b);
  });

  it('accepts arguments array', () => {
    const b = builder();
    expect(
      b.invokeContract({
        contractId: DEST,
        functionName: 'hello',
        args: ['world', 123, true, { address: DEST }],
      }),
    ).toBe(b);
  });

  it('throws on empty contract ID', () => {
    expect(() =>
      builder().invokeContract({
        contractId: '',
        functionName: 'hello',
      }),
    ).toThrow('must be a non-empty string');
  });

  it('throws on empty function name', () => {
    expect(() =>
      builder().invokeContract({
        contractId: DEST,
        functionName: '',
      }),
    ).toThrow('must be a non-empty string');
  });

  it('throws on invalid contract ID format', () => {
    expect(() =>
      builder().invokeContract({
        contractId: 'not-an-address',
        functionName: 'hello',
      }),
    ).toThrow('Invalid contract ID format');
  });

  it('defaults auth to an empty array when omitted', () => {
    const b = builder().invokeContract({
      contractId: DEST,
      functionName: 'hello',
    });
    const op = (b as any).operations[0];
    const auth = op.body().invokeHostFunctionOp().auth();
    expect(auth).toEqual([]);
    expect(b.describe().operations[0].params).toEqual({
      contractId: DEST,
      functionName: 'hello',
    });
  });

  it('accepts an explicit empty authorization array', () => {
    const b = builder().invokeContract({
      contractId: DEST,
      functionName: 'hello',
      auth: [],
    });
    const op = (b as any).operations[0];
    const auth = op.body().invokeHostFunctionOp().auth();
    expect(auth).toEqual([]);
    expect((b.describe().operations[0].params as any).auth).toEqual([]);
  });

  it('accepts explicitly supplied authorization entries', () => {
    const entry1 = createAddressAuthEntry();
    const entry2 = createSourceAccountAuthEntry();
    const b = builder().invokeContract({
      contractId: DEST,
      functionName: 'hello',
      auth: [entry1, entry2],
    });
    const op = (b as any).operations[0];
    const auth = op.body().invokeHostFunctionOp().auth();
    expect(auth).toHaveLength(2);
    expect(auth[0].toXDR('base64')).toBe(entry1.toXDR('base64'));
    expect(auth[1].toXDR('base64')).toBe(entry2.toXDR('base64'));
    expect((b.describe().operations[0].params as any).auth).toEqual([entry1, entry2]);
  });

  it('throws TxBuilderValidationError when auth is not an array', () => {
    const invalidAuthInputs = [
      'not-an-array',
      123,
      true,
      {},
      null,
      Symbol('auth'),
      BigInt(42),
      () => [],
    ];
    for (const invalidAuth of invalidAuthInputs) {
      expect(() =>
        builder().invokeContract({
          contractId: DEST,
          functionName: 'hello',
          auth: invalidAuth as any,
        }),
      ).toThrow(TxBuilderValidationError);

      expect(() =>
        builder().invokeContract({
          contractId: DEST,
          functionName: 'hello',
          auth: invalidAuth as any,
        }),
      ).toThrow('Authorization entries must be an array');
    }
  });

  it('throws TxBuilderValidationError when auth entries are invalid', () => {
    const validEntry = createSourceAccountAuthEntry();
    const invalidEntriesList = [
      [null],
      [undefined],
      ['string-entry'],
      [123],
      [{}],
      [{ credentials: {}, rootInvocation: {} }],
      [validEntry, null],
      [validEntry, {}],
      [validEntry, 'invalid'],
    ];

    for (const invalidEntries of invalidEntriesList) {
      expect(() =>
        builder().invokeContract({
          contractId: DEST,
          functionName: 'hello',
          auth: invalidEntries as any,
        }),
      ).toThrow(TxBuilderValidationError);

      expect(() =>
        builder().invokeContract({
          contractId: DEST,
          functionName: 'hello',
          auth: invalidEntries as any,
        }),
      ).toThrow(
        'Invalid authorization entry: each entry must be an instance of xdr.SorobanAuthorizationEntry',
      );
    }
  });

  it('does not mutate builder state after authorization validation failure', () => {
    const b = builder().addPayment({ destination: DEST, amount: '10', asset: 'XLM' });
    const initialOpCount = (b as any).operations.length;
    const initialDescCount = b.describe().operations.length;

    expect(() =>
      b.invokeContract({
        contractId: DEST,
        functionName: 'hello',
        auth: 'not-an-array' as any,
      }),
    ).toThrow(TxBuilderValidationError);

    expect(() =>
      b.invokeContract({
        contractId: DEST,
        functionName: 'hello',
        auth: [{}] as any,
      }),
    ).toThrow(TxBuilderValidationError);

    expect(() =>
      b.invokeContract({
        contractId: DEST,
        functionName: 'hello',
        auth: [null] as any,
      }),
    ).toThrow(TxBuilderValidationError);

    expect((b as any).operations).toHaveLength(initialOpCount);
    expect(b.describe().operations).toHaveLength(initialDescCount);

    // Verify builder remains operable after failure
    b.invokeContract({
      contractId: DEST,
      functionName: 'hello',
      auth: [],
    });
    expect((b as any).operations).toHaveLength(initialOpCount + 1);
    expect(b.describe().operations).toHaveLength(initialDescCount + 1);
  });
});

describe('wrapInFeeBump() (deprecated)', () => {
  it('throws immediately explaining that fee-bump wrapping is now post-build', () => {
    expect(() => builder().wrapInFeeBump(DEST)).toThrow(
      'TxBuilder.wrapInFeeBump() is deprecated and not supported',
    );
  });

  it('throws immediately even with a custom fee', () => {
    expect(() => builder().wrapInFeeBump(DEST, '200')).toThrow(
      'TxBuilder.wrapInFeeBump() is deprecated and not supported',
    );
  });

  it('throws immediately on an invalid fee source address', () => {
    expect(() => builder().wrapInFeeBump('not-an-address')).toThrow(
      'TxBuilder.wrapInFeeBump() is deprecated and not supported',
    );
  });

  it('throw message provides example code for post-build wrapping', () => {
    expect(() => builder().wrapInFeeBump(DEST)).toThrow(
      'Fee-bump wrapping must be performed on a signed built transaction',
    );
    expect(() => builder().wrapInFeeBump(DEST)).toThrow('tx.wrapInFeeBump({ feeSource, baseFee })');
  });
});

describe('setMemo()', () => {
  it('chains correctly', () => {
    const b = builder();
    expect(b.setMemo('hello')).toBe(b);
  });

  it('throws when memo exceeds 28 bytes', () => {
    expect(() => builder().setMemo('a'.repeat(29))).toThrow('28-byte limit');
  });

  it('accepts exactly 28 bytes', () => {
    expect(() => builder().setMemo('a'.repeat(28))).not.toThrow();
  });

  it('throws on empty memo', () => {
    expect(() => builder().setMemo('')).toThrow('must be a non-empty string');
  });
});

describe('setTimebounds()', () => {
  it('chains correctly with a relative maxTime', () => {
    const b = builder();
    expect(b.setTimebounds({ maxTime: '+5m' })).toBe(b);
  });

  it('accepts unix timestamp numbers', () => {
    expect(() =>
      builder().setTimebounds({ maxTime: Math.floor(Date.now() / 1000) + 300 }),
    ).not.toThrow();
  });

  it('accepts ISO date strings', () => {
    expect(() =>
      builder().setTimebounds({ maxTime: new Date(Date.now() + 60000).toISOString() }),
    ).not.toThrow();
  });

  it('throws on unrecognised relative string', () => {
    expect(() => builder().setTimebounds({ maxTime: '+5x' })).toThrow('Invalid time value');
  });

  it('sets correct absolute maxTime for relative +5m', async () => {
    const b = builder().addPayment({ destination: DEST, amount: '10', asset: 'XLM' });
    b.setTimebounds({ maxTime: '+5m' });

    const built = await b.build();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
    const tx = new sdk.Transaction(built.xdr, sdk.Networks.TESTNET);

    const expectedMaxTime = Math.floor(Date.now() / 1000) + 300;
    const actualMaxTime = parseInt(tx.timeBounds!.maxTime.toString());

    // Allow 5 seconds tolerance for test execution time
    expect(Math.abs(actualMaxTime - expectedMaxTime)).toBeLessThanOrEqual(5);
  });

  it('sets correct absolute minTime and maxTime for relative times', async () => {
    const b = builder().addPayment({ destination: DEST, amount: '10', asset: 'XLM' });
    b.setTimebounds({ minTime: '+1m', maxTime: '+5m' });

    const built = await b.build();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
    const tx = new sdk.Transaction(built.xdr, sdk.Networks.TESTNET);

    const expectedMinTime = Math.floor(Date.now() / 1000) + 60;
    const expectedMaxTime = Math.floor(Date.now() / 1000) + 300;
    const actualMinTime = parseInt(tx.timeBounds!.minTime.toString());
    const actualMaxTime = parseInt(tx.timeBounds!.maxTime.toString());

    // Allow 5 seconds tolerance for test execution time
    expect(Math.abs(actualMinTime - expectedMinTime)).toBeLessThanOrEqual(5);
    expect(Math.abs(actualMaxTime - expectedMaxTime)).toBeLessThanOrEqual(5);
  });

  it('preserves TimeoutInfinite when no timebounds set', async () => {
    const b = builder().addPayment({ destination: DEST, amount: '10', asset: 'XLM' });

    const built = await b.build();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
    const tx = new sdk.Transaction(built.xdr, sdk.Networks.TESTNET);

    expect(tx.timeBounds!.maxTime.toString()).toBe('0');
    expect(tx.timeBounds!.minTime.toString()).toBe('0');
  });
});

describe('build()', () => {
  it('throws when no operations have been added', async () => {
    const b = builder();
    await expect(b.build()).rejects.toThrow('Cannot build a transaction with no operations');
  });

  it('throws if sorobanUrl is missing for invokeContract', async () => {
    const b = builder().invokeContract({ contractId: DEST, functionName: 'hello' });
    await expect(b.build()).rejects.toThrow('sorobanUrl is required');
  });

  it('calls prepareTransaction for invokeContract', async () => {
    const b = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    }).invokeContract({ contractId: DEST, functionName: 'hello' });
    const built = await b.build();
    expect(built.xdr).toBeDefined();
  });

  it('resolves with a BuiltTransaction containing valid XDR', async () => {
    const tx = await builder()
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .build();

    expect(typeof tx.toXDR()).toBe('string');
    expect(tx.toXDR().length).toBeGreaterThan(0);
  });

  it('supports multi-operation transactions', async () => {
    const tx = await builder()
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .addPayment({ destination: DEST, amount: '20', asset: 'XLM' })
      .build();

    expect(tx.toXDR()).toBeTruthy();
  });

  it('sets memo on the built transaction', async () => {
    const tx = await builder()
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM', memo: 'grant-001' })
      .build();
    expect(tx.toXDR()).toBeTruthy();
  });
});

describe('BuiltTransaction.sign()', () => {
  it('returns BuiltTransaction for chaining', async () => {
    const tx = await builder()
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .build();

    expect(tx.sign(MOCK_SOURCE)).toBe(tx);
  });

  it('updates xdr after signing', async () => {
    const tx = await builder()
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .build();

    const before = tx.xdr;
    tx.sign(MOCK_SOURCE);
    expect(tx.xdr).not.toBe(before);
  });
});

describe('BuiltTransaction.submit()', () => {
  it('returns a SubmitResult with hash, ledger, and successful flag', async () => {
    const result = await (
      await builder().addPayment({ destination: DEST, amount: '10', asset: 'XLM' }).build()
    )
      .sign(MOCK_SOURCE)
      .submit();

    expect(result.hash).toBe('abc123');
    expect(result.ledger).toBe(1000);
    expect(result.successful).toBe(true);
  });
});

describe('fluent chain (end-to-end)', () => {
  it('builds, signs, and submits in one chain', async () => {
    const result = await (
      await TxBuilder.for(MOCK_SOURCE, { network: 'testnet' })
        .addPayment({ destination: DEST, amount: '100', asset: 'XLM' })
        .addPayment({ destination: DEST, amount: '50', asset: { code: 'USDC', issuer: DEST } })
        .setMemo('batch payout')
        .setTimebounds({ maxTime: '+5m' })
        .build()
    )
      .sign(MOCK_SOURCE)
      .submit();

    expect(result.successful).toBe(true);
    expect(result.hash).toBeTruthy();
  });
});

describe('describe()', () => {
  it('returns a plain-object representation of the builder state', () => {
    const b = builder()
      .setMemo('hello')
      .setTimebounds({ minTime: 1000, maxTime: 2000 })
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .addCreateAccount({ destination: DEST, startingBalance: '5' });

    const desc = b.describe();

    expect(desc.network).toBe('testnet');
    expect(desc.source).toBe(MOCK_SOURCE.publicKey());
    expect(desc.fee).toBe('100');
    expect(desc.memo).toBe('hello');
    expect(desc.timebounds).toEqual({ minTime: 1000, maxTime: 2000 });
    expect(desc.operations).toHaveLength(2);
    expect(desc.operations[0].type).toBe('payment');
    expect(desc.operations[0].params).toEqual({ destination: DEST, amount: '10', asset: 'XLM' });
    expect(desc.operations[1].type).toBe('createAccount');
    expect(desc.operations[1].params).toEqual({ destination: DEST, startingBalance: '5' });
  });
});

describe('operation-level sourceAccount support', () => {
  const customSource = Keypair.random().publicKey();

  it('validates and applies sourceAccount across all supported operation types', () => {
    const b = builder()
      .addPayment({
        destination: DEST,
        amount: '10',
        asset: 'XLM',
        sourceAccount: customSource,
      })
      .addCreateAccount({
        destination: DEST,
        startingBalance: '10',
        sourceAccount: customSource,
      })
      .addChangeTrust({
        asset: { code: 'USDC', issuer: DEST },
        limit: '100',
        sourceAccount: customSource,
      })
      .addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '5',
        price: '2',
        sourceAccount: customSource,
      })
      .addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '5',
        price: '2',
        sourceAccount: customSource,
      })
      .addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '5',
        sourceAccount: customSource,
      })
      .addSetOptions({
        homeDomain: 'stellar.org',
        sourceAccount: customSource,
      })
      .addManageData({
        name: 'test-key',
        value: 'test-val',
        sourceAccount: customSource,
      })
      .invokeContract({
        contractId: DEST,
        functionName: 'hello',
        sourceAccount: customSource,
      });

    const desc = b.describe();
    expect(desc.operations).toHaveLength(9);
    for (const op of desc.operations) {
      expect((op.params as { sourceAccount?: string }).sourceAccount).toBe(customSource);
    }
  });

  it('rejects invalid sourceAccount across builder methods without state mutation', () => {
    const invalidKey = 'G_NOT_A_VALID_KEY';

    const testCases: [string, () => void][] = [
      [
        'addPayment',
        () =>
          builder().addPayment({
            destination: DEST,
            amount: '10',
            asset: 'XLM',
            sourceAccount: invalidKey,
          }),
      ],
      [
        'addCreateAccount',
        () =>
          builder().addCreateAccount({
            destination: DEST,
            startingBalance: '10',
            sourceAccount: invalidKey,
          }),
      ],
      [
        'addChangeTrust',
        () =>
          builder().addChangeTrust({
            asset: { code: 'USDC', issuer: DEST },
            sourceAccount: invalidKey,
          }),
      ],
      [
        'addManageOffer',
        () =>
          builder().addManageOffer({
            selling: 'XLM',
            buying: { code: 'USDC', issuer: DEST },
            amount: '5',
            price: '2',
            sourceAccount: invalidKey,
          }),
      ],
      [
        'addManageBuyOffer',
        () =>
          builder().addManageBuyOffer({
            selling: 'XLM',
            buying: { code: 'USDC', issuer: DEST },
            amount: '5',
            price: '2',
            sourceAccount: invalidKey,
          }),
      ],
      [
        'addPathPayment',
        () =>
          builder().addPathPayment({
            destination: DEST,
            sendAsset: 'XLM',
            sendAmount: '10',
            destAsset: { code: 'USDC', issuer: DEST },
            destAmount: '5',
            sourceAccount: invalidKey,
          }),
      ],
      [
        'addSetOptions',
        () => builder().addSetOptions({ homeDomain: 'example.com', sourceAccount: invalidKey }),
      ],
      [
        'addManageData',
        () => builder().addManageData({ name: 'k', value: 'v', sourceAccount: invalidKey }),
      ],
      [
        'invokeContract',
        () =>
          builder().invokeContract({
            contractId: DEST,
            functionName: 'fn',
            sourceAccount: invalidKey,
          }),
      ],
    ];

    for (const [, fn] of testCases) {
      expect(fn).toThrow(TxBuilderValidationError);
    }
  });
});

describe('TxBuilder.fromXDR()', () => {
  it('restores a TxBuilder from an XDR string', async () => {
    // 1. Build original transaction
    const original = builder()
      .setMemo('restore-me')
      .setTimebounds({ minTime: 1000, maxTime: 2000 })
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .addChangeTrust({ asset: { code: 'USDC', issuer: DEST }, limit: '1000' });

    const built = await original.build();
    const xdr = built.toXDR();

    // 2. Restore builder
    const restored = TxBuilder.fromXDR(xdr, { network: 'testnet' });

    // 3. Compare describe() outputs
    const originalDesc = original.describe();
    const restoredDesc = restored.describe();

    // The stellar SDK parses amounts into full 7-decimal point precision strings
    // (e.g. "10" -> "10.0000000"). We normalize our originalDesc expectation to match.
    originalDesc.operations[0].params = {
      ...(originalDesc.operations[0].params as Record<string, unknown>),
      amount: '10.0000000',
    } as any;
    originalDesc.operations[1].params = {
      ...(originalDesc.operations[1].params as Record<string, unknown>),
      limit: '1000.0000000',
    } as any;

    // Note: parsed transactions may have slightly different structure for timebounds internally depending on string/number representation,
    // but our describe() normalizes them.
    expect(restoredDesc).toEqual(originalDesc);
  });

  it('preserves a non-default base fee from XDR when options.fee is omitted', async () => {
    const original = TxBuilder.for(MOCK_SOURCE, { network: 'testnet', fee: '350' }).addPayment({
      destination: DEST,
      amount: '10',
      asset: 'XLM',
    });

    const built = await original.build();
    const xdr = built.toXDR();

    const restored = TxBuilder.fromXDR(xdr, { network: 'testnet' });
    expect(restored.describe().fee).toBe('350');

    const restoredBuilt = await restored.build();
    const restoredTx = new Transaction(restoredBuilt.toXDR(), Networks.TESTNET);
    expect(restoredTx.fee).toBe('350');
  });

  it('overrides the base fee when options.fee is explicitly provided in fromXDR()', async () => {
    const original = TxBuilder.for(MOCK_SOURCE, { network: 'testnet', fee: '100' })
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .addPayment({ destination: DEST, amount: '20', asset: 'XLM' });

    const built = await original.build();
    const xdr = built.toXDR();

    const restored = TxBuilder.fromXDR(xdr, { network: 'testnet', fee: '500' });
    expect(restored.describe().fee).toBe('500');

    const restoredBuilt = await restored.build();
    const restoredTx = new Transaction(restoredBuilt.toXDR(), Networks.TESTNET);
    // 2 operations with base fee 500 = total fee 1000
    expect(restoredTx.fee).toBe('1000');
  });

  it('preserves an explicit fee of "0" in fromXDR() rather than falling back to XDR base fee', async () => {
    const original = TxBuilder.for(MOCK_SOURCE, { network: 'testnet', fee: '250' }).addPayment({
      destination: DEST,
      amount: '10',
      asset: 'XLM',
    });

    const built = await original.build();
    const xdr = built.toXDR();

    const restored = TxBuilder.fromXDR(xdr, { network: 'testnet', fee: '0' });
    expect(restored.describe().fee).toBe('0');

    const restoredBuilt = await restored.build();
    const restoredTx = new Transaction(restoredBuilt.toXDR(), Networks.TESTNET);
    expect(restoredTx.fee).toBe('0');
  });

  it('throws TxBuilderValidationError on unsupported operation types', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');

    // Create an XDR envelope with an accountMerge operation (unsupported by stellar-flow)
    const tx = new sdk.TransactionBuilder(new sdk.Account(MOCK_SOURCE.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: sdk.Networks.TESTNET,
    })
      .addOperation(sdk.Operation.accountMerge({ destination: DEST }))
      .setTimeout(100)
      .build();

    const xdr = tx.toXDR();

    expect(() => TxBuilder.fromXDR(xdr, { network: 'testnet' })).toThrow(
      'Unsupported operation type in fromXDR: accountMerge',
    );
  });

  it('restores manageSellOffer and manageBuyOffer preserving accurate prices', async () => {
    const original = builder()
      .addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '100',
        price: '0.57',
      })
      .addManageBuyOffer({
        selling: { code: 'USDC', issuer: DEST },
        buying: 'XLM',
        amount: '50',
        price: '60000',
      });

    const built = await original.build();
    const xdr = built.toXDR();

    const restored = TxBuilder.fromXDR(xdr, { network: 'testnet' });
    const restoredBuilt = await restored.build();
    expect(restoredBuilt.toXDR()).toBeTruthy();

    const desc = restored.describe();
    expect(desc.operations).toHaveLength(2);
    expect(desc.operations[0].type).toBe('manageSellOffer');
    expect((desc.operations[0].params as any).price).toBe('0.57');
    expect(desc.operations[1].type).toBe('manageBuyOffer');
    expect((desc.operations[1].params as any).price).toBe('60000');
  });

  it('preserves a single authorization entry in fromXDR()', async () => {
    const entry = createAddressAuthEntry();
    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    }).invokeContract({
      contractId: DEST,
      functionName: 'test_fn',
      auth: [entry],
    });

    const built = await original.build();
    const xdrString = built.toXDR();

    const restored = TxBuilder.fromXDR(xdrString, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });

    const origOp = (original as any).operations[0];
    const restoredOp = (restored as any).operations[0];

    expect(restoredOp.toXDR('base64')).toBe(origOp.toXDR('base64'));

    const restoredAuth = restoredOp.body().invokeHostFunctionOp().auth();
    expect(restoredAuth).toHaveLength(1);
    expect(restoredAuth[0].toXDR('base64')).toBe(entry.toXDR('base64'));

    const desc = restored.describe();
    expect(desc.operations).toHaveLength(1);
    expect(desc.operations[0].type).toBe('invokeContract');
    const params = desc.operations[0].params as any;
    expect(params.auth).toHaveLength(1);
    expect(params.auth[0].toXDR('base64')).toBe(entry.toXDR('base64'));
  });

  it('preserves multiple authorization entries in fromXDR()', async () => {
    const entry1 = createAddressAuthEntry();
    const entry2 = createSourceAccountAuthEntry();
    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    }).invokeContract({
      contractId: DEST,
      functionName: 'test_multi',
      auth: [entry1, entry2],
    });

    const built = await original.build();
    const xdrString = built.toXDR();

    const restored = TxBuilder.fromXDR(xdrString, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });

    const restoredOp = (restored as any).operations[0];
    const restoredAuth = restoredOp.body().invokeHostFunctionOp().auth();
    expect(restoredAuth).toHaveLength(2);
    expect(restoredAuth[0].toXDR('base64')).toBe(entry1.toXDR('base64'));
    expect(restoredAuth[1].toXDR('base64')).toBe(entry2.toXDR('base64'));
  });

  it('preserves full authorization details including credentials, signatures, root invocations, and nested sub-invocations', async () => {
    const subContractId = Keypair.random().publicKey();
    const complexEntry = createAddressAuthEntry(DEST, subContractId);

    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    }).invokeContract({
      contractId: DEST,
      functionName: 'root_fn',
      auth: [complexEntry],
    });

    const built = await original.build();
    const xdrString = built.toXDR();

    const restored = TxBuilder.fromXDR(xdrString, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });

    const restoredOp = (restored as any).operations[0];
    const restoredEntry = restoredOp.body().invokeHostFunctionOp().auth()[0];

    // Verify exact XDR round-trip byte-for-byte fidelity
    expect(restoredEntry.toXDR('base64')).toBe(complexEntry.toXDR('base64'));

    // Verify individual components
    // Credentials
    const creds = restoredEntry.credentials();
    expect(creds.switch().name).toBe('sorobanCredentialsAddress');
    const addrCreds = creds.address();
    expect(addrCreds.nonce().toString()).toBe('12345');
    expect(addrCreds.signatureExpirationLedger()).toBe(99999);
    expect(addrCreds.signature().bytes().toString('utf8')).toBe('test_signature');

    // Root invocation
    const rootInv = restoredEntry.rootInvocation();
    expect(rootInv.function().switch().name).toBe('sorobanAuthorizedFunctionTypeContractFn');
    const rootFn = rootInv.function().contractFn();
    expect(rootFn.functionName().toString('utf8')).toBe('root_fn');
    expect(rootFn.args()).toHaveLength(1);
    expect(rootFn.args()[0].u32()).toBe(42);

    // Sub-invocations
    expect(rootInv.subInvocations()).toHaveLength(1);
    const subInv = rootInv.subInvocations()[0];
    expect(subInv.function().switch().name).toBe('sorobanAuthorizedFunctionTypeContractFn');
    const subFn = subInv.function().contractFn();
    expect(subFn.functionName().toString('utf8')).toBe('sub_fn');
    expect(subFn.args()).toHaveLength(1);
    expect(subFn.args()[0].str().toString('utf8')).toBe('sub_arg');

    // Operation XDR round-trip match
    const origOp = (original as any).operations[0];
    expect(restoredOp.toXDR('base64')).toBe(origOp.toXDR('base64'));

    // Re-build check
    const restoredBuilt = await restored.build();
    expect(restoredBuilt.xdr).toBeDefined();
  });

  it('preserves empty authorization list across fromXDR()', async () => {
    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    }).invokeContract({
      contractId: DEST,
      functionName: 'no_auth_fn',
    });

    const built = await original.build();
    const xdrString = built.toXDR();

    const restored = TxBuilder.fromXDR(xdrString, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });

    const restoredOp = (restored as any).operations[0];
    const restoredAuth = restoredOp.body().invokeHostFunctionOp().auth();
    expect(restoredAuth).toEqual([]);
  });

  it('preserves multi-level deeply nested sub-invocations in fromXDR()', async () => {
    const subContract1 = Keypair.random().publicKey();
    const subContract2 = Keypair.random().publicKey();

    const leafSubInv = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(subContract2).toScAddress(),
          functionName: 'leaf_fn',
          args: [xdr.ScVal.scvU64(xdr.Uint64.fromString('999999'))],
        }),
      ),
      subInvocations: [],
    });

    const middleSubInv = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(subContract1).toScAddress(),
          functionName: 'mid_fn',
          args: [xdr.ScVal.scvString('mid_arg')],
        }),
      ),
      subInvocations: [leafSubInv],
    });

    const rootInv = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(DEST).toScAddress(),
          functionName: 'deep_fn',
          args: [],
        }),
      ),
      subInvocations: [middleSubInv],
    });

    const deepEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: rootInv,
    });

    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    }).invokeContract({
      contractId: DEST,
      functionName: 'deep_fn',
      auth: [deepEntry],
    });

    const built = await original.build();
    const restored = TxBuilder.fromXDR(built.toXDR(), {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });

    const restoredOp = (restored as any).operations[0];
    const restoredEntry = restoredOp.body().invokeHostFunctionOp().auth()[0];

    expect(restoredEntry.toXDR('base64')).toBe(deepEntry.toXDR('base64'));
    const restoredRoot = restoredEntry.rootInvocation();
    expect(restoredRoot.subInvocations()).toHaveLength(1);
    const restoredMid = restoredRoot.subInvocations()[0];
    expect(restoredMid.function().contractFn().functionName().toString('utf8')).toBe('mid_fn');
    expect(restoredMid.subInvocations()).toHaveLength(1);
    const restoredLeaf = restoredMid.subInvocations()[0];
    expect(restoredLeaf.function().contractFn().functionName().toString('utf8')).toBe('leaf_fn');
    expect(restoredLeaf.function().contractFn().args()[0].u64().toString()).toBe('999999');
  });

  it('preserves distinct authorization entries across multiple operations in fromXDR()', async () => {
    const entryA = createAddressAuthEntry(DEST);
    const entryB = createSourceAccountAuthEntry(DEST);

    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    })
      .addPayment({ destination: DEST, amount: '10', asset: 'XLM' })
      .invokeContract({
        contractId: DEST,
        functionName: 'fn_with_auth',
        auth: [entryA, entryB],
      })
      .invokeContract({
        contractId: DEST,
        functionName: 'fn_without_auth',
      });

    const built = await original.build();
    const restored = TxBuilder.fromXDR(built.toXDR(), {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });

    const restoredOps = (restored as any).operations;
    expect(restoredOps).toHaveLength(3);

    // Op 0: Payment
    expect(restoredOps[0].body().switch().name).toBe('payment');

    // Op 1: InvokeContract with 2 auth entries
    expect(restoredOps[1].body().switch().name).toBe('invokeHostFunction');
    const auth1 = restoredOps[1].body().invokeHostFunctionOp().auth();
    expect(auth1).toHaveLength(2);
    expect(auth1[0].toXDR('base64')).toBe(entryA.toXDR('base64'));
    expect(auth1[1].toXDR('base64')).toBe(entryB.toXDR('base64'));

    // Op 2: InvokeContract with 0 auth entries
    expect(restoredOps[2].body().switch().name).toBe('invokeHostFunction');
    const auth2 = restoredOps[2].body().invokeHostFunctionOp().auth();
    expect(auth2).toEqual([]);
  });

  it('throws TxBuilderValidationError when fromXDR encounters an unsupported invokeHostFunction type', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');

    const tx = new sdk.TransactionBuilder(new sdk.Account(MOCK_SOURCE.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: sdk.Networks.TESTNET,
    })
      .addOperation(
        sdk.Operation.invokeHostFunction({
          func: sdk.xdr.HostFunction.hostFunctionTypeCreateContract(
            new sdk.xdr.CreateContractArgs({
              contractIdPreimage: sdk.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                new sdk.xdr.ContractIdPreimageFromAddress({
                  address: new sdk.Address(DEST).toScAddress(),
                  salt: sdk.xdr.Uint256.fromXDR(Buffer.alloc(32)),
                }),
              ),
              executable: sdk.xdr.ContractExecutable.contractExecutableStellarAsset(),
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(100)
      .build();

    expect(() => TxBuilder.fromXDR(tx.toXDR(), { network: 'testnet' })).toThrow(
      'Unsupported invokeHostFunction type in fromXDR',
    );
  });

  it('round-trips a LiquidityPoolAsset changeTrust operation through XDR', async () => {
    const lpAsset = new LiquidityPoolAsset(
      Asset.native(),
      new Asset('USDC', DEST),
      LiquidityPoolFeeV18,
    );

    const original = builder().addChangeTrust({ asset: lpAsset, limit: '5000' });
    const built = await original.build();
    const xdrString = built.toXDR();

    const restored = TxBuilder.fromXDR(xdrString, { network: 'testnet' });
    const restoredDesc = restored.describe();

    expect(restoredDesc.operations).toHaveLength(1);
    expect(restoredDesc.operations[0].type).toBe('changeTrust');
    const restoredParams = restoredDesc.operations[0].params as ChangeTrustParams;
    expect(restoredParams.asset).toBeInstanceOf(LiquidityPoolAsset);
    expect((restoredParams.asset as LiquidityPoolAsset).equals(lpAsset)).toBe(true);
    expect(restoredParams.limit).toBe('5000.0000000');

    // Rebuild transaction from restored builder and verify liquidity pool asset in XDR
    const rebuilt = await restored.build();
    const rebuiltTx = new Transaction(rebuilt.toXDR(), Networks.TESTNET);
    const restoredOp = rebuiltTx.operations[0];
    expect(restoredOp.type).toBe('changeTrust');
    if (restoredOp.type === 'changeTrust') {
      expect(restoredOp.line).toBeInstanceOf(LiquidityPoolAsset);
      expect((restoredOp.line as LiquidityPoolAsset).equals(lpAsset)).toBe(true);
      expect(restoredOp.limit).toBe('5000.0000000');
    }
  });

  it('preserves standard credit asset trustlines alongside LiquidityPoolAsset trustlines', async () => {
    const creditAsset = { code: 'USDC', issuer: DEST };
    const lpAsset = new LiquidityPoolAsset(
      Asset.native(),
      new Asset('USDC', DEST),
      LiquidityPoolFeeV18,
    );

    const original = builder()
      .addChangeTrust({ asset: creditAsset, limit: '1000' })
      .addChangeTrust({ asset: lpAsset, limit: '2000' });

    const built = await original.build();
    const restored = TxBuilder.fromXDR(built.toXDR(), { network: 'testnet' });
    const desc = restored.describe();

    expect(desc.operations).toHaveLength(2);
    expect(desc.operations[0].type).toBe('changeTrust');
    expect((desc.operations[0].params as ChangeTrustParams).asset).toEqual(creditAsset);
    expect(desc.operations[1].type).toBe('changeTrust');
    expect(
      ((desc.operations[1].params as ChangeTrustParams).asset as LiquidityPoolAsset).equals(
        lpAsset,
      ),
    ).toBe(true);
  });

  it('preserves custom operation source accounts and omits source when default in fromXDR()', async () => {
    const customSource = Keypair.random().publicKey();

    const original = builder()
      .addPayment({
        destination: DEST,
        amount: '10',
        asset: 'XLM',
        sourceAccount: customSource,
      })
      .addPayment({
        destination: DEST,
        amount: '20',
        asset: 'XLM',
      });

    const built = await original.build();
    const restored = TxBuilder.fromXDR(built.toXDR(), { network: 'testnet' });
    const desc = restored.describe();

    expect(desc.operations).toHaveLength(2);
    // Op 0 has custom source account preserved
    expect((desc.operations[0].params as { sourceAccount?: string }).sourceAccount).toBe(
      customSource,
    );
    // Op 1 did not have a custom source account; restored descriptor does not have sourceAccount
    expect((desc.operations[1].params as { sourceAccount?: string }).sourceAccount).toBeUndefined();

    // Verify rebuilt transaction preserves operation-level sources in SDK Transaction
    const rebuilt = await restored.build();
    const rebuiltTx = new Transaction(rebuilt.toXDR(), Networks.TESTNET);
    expect(rebuiltTx.operations[0].source).toBe(customSource);
    expect(rebuiltTx.operations[1].source).toBeUndefined();
  });

  it('preserves distinct custom source accounts across mixed operations in fromXDR()', async () => {
    const customSource1 = Keypair.random().publicKey();
    const customSource2 = Keypair.random().publicKey();
    const customSource3 = Keypair.random().publicKey();

    const original = builder()
      .addPayment({
        destination: DEST,
        amount: '15',
        asset: 'XLM',
        sourceAccount: customSource1,
      })
      .addChangeTrust({
        asset: { code: 'USDC', issuer: DEST },
        limit: '500',
        sourceAccount: customSource2,
      })
      .addManageData({
        name: 'testKey',
        value: 'testValue',
        sourceAccount: customSource3,
      })
      .addCreateAccount({
        destination: DEST,
        startingBalance: '5',
      });

    const built = await original.build();
    const restored = TxBuilder.fromXDR(built.toXDR(), { network: 'testnet' });
    const desc = restored.describe();

    expect(desc.operations).toHaveLength(4);
    expect((desc.operations[0].params as { sourceAccount?: string }).sourceAccount).toBe(
      customSource1,
    );
    expect((desc.operations[1].params as { sourceAccount?: string }).sourceAccount).toBe(
      customSource2,
    );
    expect((desc.operations[2].params as { sourceAccount?: string }).sourceAccount).toBe(
      customSource3,
    );
    expect((desc.operations[3].params as { sourceAccount?: string }).sourceAccount).toBeUndefined();

    // Rebuild and confirm XDR reflects exact source accounts
    const rebuilt = await restored.build();
    const rebuiltTx = new Transaction(rebuilt.toXDR(), Networks.TESTNET);
    expect(rebuiltTx.operations[0].source).toBe(customSource1);
    expect(rebuiltTx.operations[1].source).toBe(customSource2);
    expect(rebuiltTx.operations[2].source).toBe(customSource3);
    expect(rebuiltTx.operations[3].source).toBeUndefined();
  });

  it('preserves custom source accounts across all 9 operation types in fromXDR()', async () => {
    const opSource = Keypair.random().publicKey();
    const lpAsset = new LiquidityPoolAsset(
      Asset.native(),
      new Asset('USDC', DEST),
      LiquidityPoolFeeV18,
    );

    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    })
      .addPayment({
        destination: DEST,
        amount: '10',
        asset: 'XLM',
        sourceAccount: opSource,
      })
      .addCreateAccount({
        destination: DEST,
        startingBalance: '10',
        sourceAccount: opSource,
      })
      .addChangeTrust({
        asset: lpAsset,
        limit: '100',
        sourceAccount: opSource,
      })
      .addManageOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '5',
        price: '2',
        sourceAccount: opSource,
      })
      .addManageBuyOffer({
        selling: 'XLM',
        buying: { code: 'USDC', issuer: DEST },
        amount: '5',
        price: '2',
        sourceAccount: opSource,
      })
      .addPathPayment({
        destination: DEST,
        sendAsset: 'XLM',
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: DEST },
        destAmount: '5',
        sourceAccount: opSource,
      })
      .addSetOptions({
        homeDomain: 'stellar.org',
        sourceAccount: opSource,
      })
      .addManageData({
        name: 'sourceTest',
        value: 'dataVal',
        sourceAccount: opSource,
      })
      .invokeContract({
        contractId: DEST,
        functionName: 'testFn',
        sourceAccount: opSource,
      });

    const built = await original.build();
    const restored = TxBuilder.fromXDR(built.toXDR(), {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });
    const desc = restored.describe();

    expect(desc.operations).toHaveLength(9);
    for (const op of desc.operations) {
      expect((op.params as { sourceAccount?: string }).sourceAccount).toBe(opSource);
    }

    const rebuilt = await restored.build();
    const rebuiltTx = new Transaction(rebuilt.toXDR(), Networks.TESTNET);
    for (const op of rebuiltTx.operations) {
      expect(op.source).toBe(opSource);
    }
  });

  it('preserves custom sourceAccount on a standalone invokeContract operation across fromXDR()', async () => {
    const customSource = Keypair.random().publicKey();

    // 1. Create a builder with a custom operation-level source account on invokeContract
    const original = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    }).invokeContract({
      contractId: DEST,
      functionName: 'hello',
      sourceAccount: customSource,
    });

    // 2. Build the Soroban transaction using the existing test mocks and valid Soroban preparation flow
    const built = await original.build();

    // 3. Serialize it to XDR
    const xdrString = built.toXDR();

    // 4. Restore it with TxBuilder.fromXDR()
    const restored = TxBuilder.fromXDR(xdrString, {
      network: 'testnet',
      sorobanUrl: 'http://localhost:8000',
    });

    // 5. Assert the restored descriptor contains the custom sourceAccount
    const desc = restored.describe();
    expect(desc.operations).toHaveLength(1);
    expect(desc.operations[0].type).toBe('invokeContract');
    expect((desc.operations[0].params as { sourceAccount?: string }).sourceAccount).toBe(
      customSource,
    );

    // 6. Rebuild the restored transaction
    const rebuilt = await restored.build();

    // 7. Parse the rebuilt XDR with the Stellar SDK
    const rebuiltTx = new Transaction(rebuilt.toXDR(), Networks.TESTNET);

    // 8. Assert it contains exactly one operation and that operation's source equals the custom source account
    expect(rebuiltTx.operations).toHaveLength(1);
    expect(rebuiltTx.operations[0].type).toBe('invokeHostFunction');
    expect(rebuiltTx.operations[0].source).toBe(customSource);
  });
});

describe('BuiltTransaction.fromXDR()', () => {
  describe('consumer type compatibility', () => {
    it('allows external classes to implement the legacy four-member BuiltTransaction interface', () => {
      class LegacyMock implements BuiltTransaction {
        xdr = 'mock-xdr';

        sign(_keypair: Keypair): BuiltTransaction {
          return this;
        }

        async submit(): Promise<SubmitResult> {
          return {
            hash: '0123456789abcdef',
            ledger: 100,
            successful: true,
            resultXdr: 'BBBB...',
          };
        }

        toXDR(): string {
          return this.xdr;
        }
      }

      const mock = new LegacyMock();
      expect(mock.xdr).toBe('mock-xdr');
      expect(mock.toXDR()).toBe('mock-xdr');
      expect(mock.sign(Keypair.random())).toBe(mock);
      const baseTx: BuiltTransaction = mock;
      expect(baseTx.xdr).toBe('mock-xdr');
    });

    it('verifies TxBuilder.build() and BuiltTransaction.fromXDR() return InspectableBuiltTransaction assignable to BuiltTransaction', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '10',
        asset: 'XLM',
      });
      const built: InspectableBuiltTransaction = await b.build();

      // Exposes hash() and signatures directly without optional chaining
      const txHash: string = built.hash();
      expect(txHash).toMatch(/^[0-9a-f]{64}$/);
      expect(built.signatures).toHaveLength(0);

      // Chaining .sign() retains InspectableBuiltTransaction
      const signed: InspectableBuiltTransaction = built.sign(SOURCE);
      expect(signed.hash()).toBe(txHash);
      expect(signed.signatures).toHaveLength(1);

      // InspectableBuiltTransaction is assignable to base BuiltTransaction
      const baseBuilt: BuiltTransaction = built;
      expect(baseBuilt.toXDR()).toBe(built.toXDR());

      // fromXDR() returns InspectableBuiltTransaction
      const restored: InspectableBuiltTransaction = BuiltTransaction.fromXDR(signed.toXDR(), {
        network: 'testnet',
      });
      expect(restored.hash()).toBe(txHash);
      expect(restored.signatures).toHaveLength(1);

      // Restored inspectable transaction is assignable to base BuiltTransaction
      const baseRestored: BuiltTransaction = restored;
      expect(baseRestored.toXDR()).toBe(restored.toXDR());
    });
  });

  describe('envelope restoration', () => {
    it('restores an unsigned transaction envelope from XDR', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '10',
        asset: 'XLM',
      });
      const built = await b.build();
      const xdrString = built.toXDR();

      const restored = BuiltTransaction.fromXDR(xdrString, { network: 'testnet' });
      expect(restored.toXDR()).toBe(xdrString);
      expect(restored.hash()).toBe(built.hash());
      expect(restored.signatures).toHaveLength(0);
    });

    it('restores a single-signed transaction envelope from XDR', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '10',
        asset: 'XLM',
      });
      const built = await b.build();
      built.sign(SOURCE);
      const xdrString = built.toXDR();

      const restored = BuiltTransaction.fromXDR(xdrString, { network: 'testnet' });
      expect(restored.toXDR()).toBe(xdrString);
      expect(restored.hash()).toBe(built.hash());
      expect(restored.signatures).toHaveLength(1);
      expect(restored.signatures[0].hint).toBe(SOURCE.signatureHint().toString('hex'));
    });

    it('restores a multi-signed transaction envelope from XDR', async () => {
      const signer2 = Keypair.random();
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '10',
        asset: 'XLM',
      });
      const built = await b.build();
      built.sign(SOURCE);
      built.sign(signer2);
      const xdrString = built.toXDR();

      const restored = BuiltTransaction.fromXDR(xdrString, { network: 'testnet' });
      expect(restored.signatures).toHaveLength(2);
      expect(restored.signatures[0].hint).toBe(SOURCE.signatureHint().toString('hex'));
      expect(restored.signatures[1].hint).toBe(signer2.signatureHint().toString('hex'));
      expect(restored.hash()).toBe(built.hash());
    });
  });

  describe('co-signing workflow', () => {
    it('allows Party B to co-sign a transaction restored from Party A without altering hash or body', async () => {
      const partyA = Keypair.random();
      const partyB = Keypair.random();

      // Party A creates and signs transaction
      const accountA = new Account(partyA.publicKey(), '100');
      const txA = new TransactionBuilder(accountA, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: DEST,
            asset: Asset.native(),
            amount: '25',
          }),
        )
        .addMemo(
          new (require('@stellar/stellar-sdk').Memo)(
            require('@stellar/stellar-sdk').MemoText,
            'co-sign test',
          ),
        )
        .setTimeout(60)
        .build();
      txA.sign(partyA);
      const partyAXdr = txA.toXDR();
      const expectedHash = txA.hash().toString('hex');

      // Party B restores envelope via BuiltTransaction.fromXDR
      const restored = BuiltTransaction.fromXDR(partyAXdr, { network: 'testnet' });
      expect(restored.hash()).toBe(expectedHash);
      expect(restored.signatures).toHaveLength(1);

      // Party B co-signs
      restored.sign(partyB);
      expect(restored.signatures).toHaveLength(2);
      expect(restored.hash()).toBe(expectedHash); // Transaction hash MUST be immutable across signatures

      // Inspect underlying SDK transaction
      const finalSdkTx = new Transaction(restored.toXDR(), Networks.TESTNET);
      expect(finalSdkTx.signatures).toHaveLength(2);

      // Cryptographically verify signatures
      const sigA = finalSdkTx.signatures[0].signature();
      const sigB = finalSdkTx.signatures[1].signature();
      expect(partyA.verify(finalSdkTx.hash(), sigA)).toBe(true);
      expect(partyB.verify(finalSdkTx.hash(), sigB)).toBe(true);
      expect(finalSdkTx.memo.value?.toString()).toBe('co-sign test');
      expect(finalSdkTx.operations).toHaveLength(1);
    });

    it('submits a co-signed restored transaction envelope to Horizon', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '5',
        asset: 'XLM',
      });
      const built = await b.build();
      built.sign(SOURCE);

      const restored = BuiltTransaction.fromXDR(built.toXDR(), { network: 'testnet' });
      const partyB = Keypair.random();
      restored.sign(partyB);

      const result = await restored.submit();
      expect(result.successful).toBe(true);
      expect(result.hash).toBe('abc123');
    });
  });

  describe('Soroban envelope preservation', () => {
    it('preserves Soroban footprint, resource data, and auth entries across restoration and co-signing', async () => {
      const partyA = Keypair.random();
      const partyB = Keypair.random();
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
      const sourceAccount = new Account(partyA.publicKey(), '100');

      const sorobanData = new SorobanDataBuilder()
        .setReadOnly([
          xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
              contract: Address.fromString(contractId).toScAddress(),
              key: xdr.ScVal.scvSymbol('counter'),
              durability: xdr.ContractDataDurability.persistent(),
            }),
          ),
        ])
        .setResourceFee('5000')
        .build();

      const authEntry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'increment',
              args: [],
            }),
          ),
          subInvocations: [],
        }),
      });

      const originalTx = new TransactionBuilder(sourceAccount, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(contractId).toScAddress(),
                functionName: 'increment',
                args: [],
              }),
            ),
            auth: [authEntry],
          }),
        )
        .setSorobanData(sorobanData)
        .setTimeout(30)
        .build();

      originalTx.sign(partyA);
      const originalXdr = originalTx.toXDR();
      const originalSorobanDataXdr = originalTx
        .toEnvelope()
        .v1()
        .tx()
        .ext()
        .sorobanData()
        .toXDR('base64');
      const originalAuthXdr = (originalTx.operations[0] as any).auth[0].toXDR('base64');

      // Restore via BuiltTransaction.fromXDR
      const restored = BuiltTransaction.fromXDR(originalXdr, { network: 'testnet' });
      expect(restored.signatures).toHaveLength(1);

      // Party B co-signs
      restored.sign(partyB);
      expect(restored.signatures).toHaveLength(2);

      // Parse co-signed envelope with SDK
      const cosignedTx = new Transaction(restored.toXDR(), Networks.TESTNET);
      expect(cosignedTx.signatures).toHaveLength(2);

      // Verify Soroban data survived byte-for-byte
      const cosignedSorobanDataXdr = cosignedTx
        .toEnvelope()
        .v1()
        .tx()
        .ext()
        .sorobanData()
        .toXDR('base64');
      expect(cosignedSorobanDataXdr).toBe(originalSorobanDataXdr);

      // Verify auth entries survived byte-for-byte
      const cosignedAuthXdr = (cosignedTx.operations[0] as any).auth[0].toXDR('base64');
      expect(cosignedAuthXdr).toBe(originalAuthXdr);

      // Cryptographically verify both signatures
      expect(partyA.verify(cosignedTx.hash(), cosignedTx.signatures[0].signature())).toBe(true);
      expect(partyB.verify(cosignedTx.hash(), cosignedTx.signatures[1].signature())).toBe(true);
    });
  });

  describe('duplicate signature idempotence', () => {
    it('is an idempotent no-op when signing multiple times with the same keypair', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '1',
        asset: 'XLM',
      });
      const built = await b.build();

      built.sign(SOURCE);
      expect(built.signatures).toHaveLength(1);
      const xdrAfterFirst = built.toXDR();

      // Sign again with same keypair
      built.sign(SOURCE);
      expect(built.signatures).toHaveLength(1);
      expect(built.toXDR()).toBe(xdrAfterFirst);

      // Sign a third time
      built.sign(SOURCE);
      expect(built.signatures).toHaveLength(1);
      expect(built.toXDR()).toBe(xdrAfterFirst);
    });

    it('remains a safe no-op when re-signing with an existing signer on an envelope with 20 signatures', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '1',
        asset: 'XLM',
      });
      const built = await b.build();

      const signers: Keypair[] = [SOURCE];
      built.sign(SOURCE);

      for (let i = 1; i < 20; i++) {
        const kp = Keypair.random();
        signers.push(kp);
        built.sign(kp);
      }
      expect(built.signatures).toHaveLength(20);
      const xdrAt20 = built.toXDR();

      // Re-sign with signer[0] (SOURCE) when at 20 signatures
      expect(() => built.sign(SOURCE)).not.toThrow();
      expect(built.signatures).toHaveLength(20);
      expect(built.toXDR()).toBe(xdrAt20);

      // Re-sign with signer[10] when at 20 signatures
      expect(() => built.sign(signers[10])).not.toThrow();
      expect(built.signatures).toHaveLength(20);
      expect(built.toXDR()).toBe(xdrAt20);
    });
  });

  describe('20-signature limit', () => {
    it('throws TxBuilderValidationError when attempting to add a 21st distinct signature', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '1',
        asset: 'XLM',
      });
      const built = await b.build();

      for (let i = 0; i < 20; i++) {
        built.sign(Keypair.random());
      }
      expect(built.signatures).toHaveLength(20);
      const xdrAt20 = built.toXDR();

      const signer21 = Keypair.random();
      expect(() => built.sign(signer21)).toThrow(TxBuilderValidationError);
      expect(() => built.sign(signer21)).toThrow(/maximum limit of 20 signatures reached/);

      // Envelope state remains unmutated and cleanly deserializable
      expect(built.signatures).toHaveLength(20);
      expect(built.toXDR()).toBe(xdrAt20);
      expect(() => new Transaction(built.toXDR(), Networks.TESTNET)).not.toThrow();
    });
  });

  describe('validation and error handling', () => {
    it('throws TxBuilderValidationError on empty or invalid XDR string', () => {
      expect(() => BuiltTransaction.fromXDR('', { network: 'testnet' })).toThrow(
        TxBuilderValidationError,
      );
      expect(() =>
        BuiltTransaction.fromXDR('not-a-valid-base64-xdr-string', { network: 'testnet' }),
      ).toThrow(TxBuilderValidationError);
    });

    it('throws TxBuilderValidationError on unknown network', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '1',
        asset: 'XLM',
      });
      const built = await b.build();

      expect(() =>
        BuiltTransaction.fromXDR(built.toXDR(), { network: 'unknown-network' as any }),
      ).toThrow(TxBuilderValidationError);
      expect(() =>
        BuiltTransaction.fromXDR(built.toXDR(), { network: 'unknown-network' as any }),
      ).toThrow(/Unknown network/);
    });

    it('throws TxBuilderValidationError when options is omitted or invalid', async () => {
      const b = TxBuilder.for(SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        amount: '1',
        asset: 'XLM',
      });
      const built = await b.build();
      const xdrString = built.toXDR();

      expect(() => (BuiltTransaction as any).fromXDR(xdrString)).toThrow(TxBuilderValidationError);
      expect(() => (BuiltTransaction as any).fromXDR(xdrString)).toThrow(
        /options must be provided and contain a valid network/,
      );
      expect(() => (BuiltTransaction as any).fromXDR(xdrString, null)).toThrow(
        TxBuilderValidationError,
      );
      expect(() => (BuiltTransaction as any).fromXDR(xdrString, 'invalid' as any)).toThrow(
        TxBuilderValidationError,
      );
    });

    it('throws TxBuilderValidationError when given a fee-bump transaction envelope', () => {
      const partyA = Keypair.random();
      const partyB = Keypair.random();
      const sourceAccount = new Account(partyA.publicKey(), '100');
      const innerTx = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: DEST,
            asset: Asset.native(),
            amount: '10',
          }),
        )
        .setTimeout(30)
        .build();
      innerTx.sign(partyA);

      const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        partyB,
        '200',
        innerTx,
        Networks.TESTNET,
      );
      feeBumpTx.sign(partyB);
      const feeBumpXdr = feeBumpTx.toXDR();

      expect(() => BuiltTransaction.fromXDR(feeBumpXdr, { network: 'testnet' })).toThrow(
        TxBuilderValidationError,
      );
      expect(() => BuiltTransaction.fromXDR(feeBumpXdr, { network: 'testnet' })).toThrow(
        /Fee-bump envelopes are not supported/,
      );
    });
  });
});
