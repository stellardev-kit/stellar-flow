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
  MuxedAccount,
  Horizon,
} from '@stellar/stellar-sdk';
import { TxBuilder, BuiltTransaction, FeeBumpBuiltTransaction } from '../src';
import {
  TxBuilderValidationError,
  TxBuilderNetworkError,
  TxBuilderSubmitError,
} from '../src/errors';
import type {
  BuiltTransaction as IBuiltTransaction,
  InspectableBuiltTransaction,
  FeeBumpBuiltTransaction as IFeeBumpBuiltTransaction,
  FeeBumpOptions,
} from '../src';

// ── fixtures & mocks ────────────────────────────────────────────────────────
const SOURCE = Keypair.random();
const SPONSOR = Keypair.random();
const SPONSOR_2 = Keypair.random();
const DEST = Keypair.random().publicKey();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  const sourceKp = actual.Keypair.random();
  const mockAccount = new actual.Account(sourceKp.publicKey(), '100');

  return {
    ...actual,
    _mockSourceKp: sourceKp,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: jest.fn().mockResolvedValue(mockAccount),
        submitTransaction: jest.fn().mockImplementation(async (tx: any) => ({
          hash: tx.hash().toString('hex'),
          ledger: 12345,
          successful: true,
          result_xdr: 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=',
        })),
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _mockSourceKp: MOCK_SOURCE } = require('@stellar/stellar-sdk') as {
  _mockSourceKp: Keypair;
};

describe('CAP-0015 Fee-Bump Transactions', () => {
  async function createSignedInnerTx(opsCount = 1, feePerOp = '100') {
    const builder = TxBuilder.for(MOCK_SOURCE, {
      network: 'testnet',
      fee: feePerOp,
    });
    for (let i = 0; i < opsCount; i++) {
      builder.addPayment({
        destination: DEST,
        asset: 'XLM',
        amount: '10',
      });
    }
    const tx = await builder.build();
    tx.sign(MOCK_SOURCE);
    return tx;
  }

  // ── 1. Construction & Wrapping Guard ──────────────────────────────────────
  describe('Construction & Wrapping Guard', () => {
    it('wraps a signed transaction with a valid G-address fee source', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({
        feeSource: SPONSOR.publicKey(),
        baseFee: '200',
      });

      expect(feeBump.feeSource).toBe(SPONSOR.publicKey());
      expect(feeBump.fee).toBe('400'); // 200 * (1 op + 1) = 400
      expect(feeBump.innerSource).toBe(MOCK_SOURCE.publicKey());
      expect(feeBump.signatures.length).toBe(0);
      expect(feeBump.innerSignatures.length).toBe(1);
    });

    it('wraps a signed transaction with a valid M-address (muxed account) fee source', async () => {
      const innerTx = await createSignedInnerTx();
      const muxed = new MuxedAccount(new Account(SPONSOR.publicKey(), '1'), '12345');
      const muxedAddress = muxed.accountId();
      expect(muxedAddress.startsWith('M')).toBe(true);

      const feeBump = innerTx.wrapInFeeBump({
        feeSource: muxedAddress,
      });

      expect(feeBump.feeSource).toBe(muxedAddress);
    });

    it('normalizes Keypair feeSource to public key string', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({
        feeSource: SPONSOR,
        baseFee: '150',
      });

      expect(feeBump.feeSource).toBe(SPONSOR.publicKey());
      expect(feeBump.fee).toBe('300');
    });

    it('rejects wrapping when inner transaction has zero signatures', async () => {
      const builder = TxBuilder.for(MOCK_SOURCE, { network: 'testnet' }).addPayment({
        destination: DEST,
        asset: 'XLM',
        amount: '10',
      });
      const unsignedTx = await builder.build();
      expect(unsignedTx.signatures.length).toBe(0);

      expect(() =>
        unsignedTx.wrapInFeeBump({
          feeSource: SPONSOR,
        }),
      ).toThrow(TxBuilderValidationError);

      expect(() =>
        unsignedTx.wrapInFeeBump({
          feeSource: SPONSOR,
        }),
      ).toThrow(/Cannot wrap an unsigned transaction in a fee-bump envelope/);
    });

    it('rejects invalid feeSource inputs', async () => {
      const innerTx = await createSignedInnerTx();

      expect(() => innerTx.wrapInFeeBump({ feeSource: 'invalid-address' })).toThrow(
        TxBuilderValidationError,
      );
      expect(() => innerTx.wrapInFeeBump({ feeSource: 'invalid-address' })).toThrow(
        /Invalid feeSource address/,
      );

      expect(() => innerTx.wrapInFeeBump({ feeSource: 12345 as any })).toThrow(
        TxBuilderValidationError,
      );
      expect(() => innerTx.wrapInFeeBump({ feeSource: null as any })).toThrow(
        TxBuilderValidationError,
      );
      expect(() => innerTx.wrapInFeeBump(null as any)).toThrow(TxBuilderValidationError);
    });

    it('does not mutate the original inner transaction during wrapping', async () => {
      const innerTx = await createSignedInnerTx();
      const originalXdr = innerTx.toXDR();
      const originalSignaturesCount = innerTx.signatures.length;
      const originalHash = innerTx.hash();

      const feeBump = innerTx.wrapInFeeBump({
        feeSource: SPONSOR,
        baseFee: '200',
      });
      feeBump.sign(SPONSOR);

      expect(innerTx.toXDR()).toBe(originalXdr);
      expect(innerTx.signatures.length).toBe(originalSignaturesCount);
      expect(innerTx.hash()).toBe(originalHash);
    });

    it('allows wrapping the same inner transaction multiple times independently', async () => {
      const innerTx = await createSignedInnerTx();

      const fb1 = innerTx.wrapInFeeBump({ feeSource: SPONSOR, baseFee: '200' });
      const fb2 = innerTx.wrapInFeeBump({ feeSource: SPONSOR_2, baseFee: '300' });

      expect(fb1.feeSource).toBe(SPONSOR.publicKey());
      expect(fb1.fee).toBe('400');
      expect(fb2.feeSource).toBe(SPONSOR_2.publicKey());
      expect(fb2.fee).toBe('600');
      expect(fb1.innerHash()).toBe(fb2.innerHash());
      expect(fb1.hash()).not.toBe(fb2.hash());
    });
  });

  // ── 2. Fees & Numeric Safety ──────────────────────────────────────────────
  describe('Fees & Numeric Safety', () => {
    it('calculates default base fee when omitted for 1-op transaction', async () => {
      const innerTx = await createSignedInnerTx(1, '100'); // rate = 100
      const fb = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      // defaultBaseFee = max(100, 100) = 100
      // total fee = 100 * (1 op + 1) = 200
      expect(fb.fee).toBe('200');
    });

    it('calculates default base fee when omitted for multi-op transaction', async () => {
      const innerTx = await createSignedInnerTx(3, '100'); // 3 ops, rate = 100
      const fb = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      // defaultBaseFee = max(100, 100) = 100
      // total fee = 100 * (3 ops + 1) = 400
      expect(fb.fee).toBe('400');
    });

    it('calculates default base fee when inner rate is above 100 stroops', async () => {
      const innerTx = await createSignedInnerTx(1, '500'); // rate = 500
      const fb = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      // defaultBaseFee = max(100, 500) = 500
      // total fee = 500 * (1 op + 1) = 1000
      expect(fb.fee).toBe('1000');
    });

    it('performs exact ceiling division for fractional inner inclusion rates', async () => {
      // Build an inner tx with 2 ops and fee = 251 (rate = 125.5)
      const acc = new Account(MOCK_SOURCE.publicKey(), '100');
      const tx = new TransactionBuilder(acc, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' }))
        .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: '2' }))
        .setTimeout(30)
        .build();

      // Modify inner fee directly in XDR to 251 stroops
      const env = tx.toEnvelope();
      env.v1().tx().fee(251);
      const modifiedXdr = env.toXDR('base64');

      const restoredInner = BuiltTransaction.fromXDR(modifiedXdr, { network: 'testnet' });
      restoredInner.sign(MOCK_SOURCE);

      // Default base fee should be ceil(251 / 2) = ceil(125.5) = 126
      const fb = restoredInner.wrapInFeeBump({ feeSource: SPONSOR });
      // outer fee = 126 * (2 + 1) = 378
      expect(fb.fee).toBe('378');

      // Supplying 125 should be rejected (< 125.5)
      expect(() =>
        restoredInner.wrapInFeeBump({
          feeSource: SPONSOR,
          baseFee: '125',
        }),
      ).toThrow(/it should be at least 126 stroops/);

      // Supplying 126 should succeed
      const fb126 = restoredInner.wrapInFeeBump({
        feeSource: SPONSOR,
        baseFee: '126',
      });
      expect(fb126.fee).toBe('378');
    });

    it('correctly accounts for Soroban resource fees', async () => {
      const contractId = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
      const invokeOp = Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: 'test',
            args: [],
          }),
        ),
        auth: [],
      });
      const sorobanData = new SorobanDataBuilder().setResourceFee(50000).build();

      const acc = new Account(MOCK_SOURCE.publicKey(), '100');
      const sorobanTx = new TransactionBuilder(acc, {
        fee: '200',
        networkPassphrase: Networks.TESTNET,
        sorobanData,
      })
        .addOperation(invokeOp)
        .setTimeout(30)
        .build();
      sorobanTx.sign(MOCK_SOURCE);

      const builtTx = BuiltTransaction.fromXDR(sorobanTx.toXDR(), { network: 'testnet' });

      // Default base fee: inner fee is 50200, resource fee is 50000 -> inclusion fee = 200 -> rate = 200
      // outer fee = 200 * (1 + 1) + 50000 = 50400
      const fbDefault = builtTx.wrapInFeeBump({ feeSource: SPONSOR });
      expect(fbDefault.fee).toBe('50400');

      // Explicit base fee 300:
      // outer fee = 300 * 2 + 50000 = 50600
      const fbExplicit = builtTx.wrapInFeeBump({
        feeSource: SPONSOR,
        baseFee: '300',
      });
      expect(fbExplicit.fee).toBe('50600');
    });

    it('enforces minimum base fee of 100 stroops', async () => {
      const innerTx = await createSignedInnerTx(1, '100');

      expect(() =>
        innerTx.wrapInFeeBump({
          feeSource: SPONSOR,
          baseFee: '99',
        }),
      ).toThrow(TxBuilderValidationError);

      expect(() =>
        innerTx.wrapInFeeBump({
          feeSource: SPONSOR,
          baseFee: 99,
        }),
      ).toThrow(/baseFee should be at least 100 stroops/);
    });

    it('rejects baseFee lower than inner inclusion fee rate', async () => {
      const innerTx = await createSignedInnerTx(1, '500'); // rate = 500

      expect(() =>
        innerTx.wrapInFeeBump({
          feeSource: SPONSOR,
          baseFee: '499',
        }),
      ).toThrow(/it should be at least 500 stroops/);
    });

    it('accepts very large valid fee strings (> Number.MAX_SAFE_INTEGER)', async () => {
      const innerTx = await createSignedInnerTx(1, '100');
      const largeFee = '4611686018427387903'; // floor(MAX_INT64 / 2)
      const fb = innerTx.wrapInFeeBump({
        feeSource: SPONSOR,
        baseFee: largeFee,
      });

      expect(fb.fee).toBe('9223372036854775806');
    });

    it('rejects baseFee when total outer fee exceeds signed Int64 limit', async () => {
      const innerTx = await createSignedInnerTx(1, '100');
      const maxInt64 = '9223372036854775807';

      expect(() =>
        innerTx.wrapInFeeBump({
          feeSource: SPONSOR,
          baseFee: maxInt64,
        }),
      ).toThrow(/exceeds maximum signed 64-bit integer/);
    });

    it('rejects unsafe numbers exceeding Number.MAX_SAFE_INTEGER', async () => {
      const innerTx = await createSignedInnerTx(1, '100');
      const unsafeNum = 9007199254740992; // Number.MAX_SAFE_INTEGER + 1

      expect(() =>
        innerTx.wrapInFeeBump({
          feeSource: SPONSOR,
          baseFee: unsafeNum,
        }),
      ).toThrow(/baseFee must be a safe integer/);
    });

    it('rejects non-integer numbers (decimals)', async () => {
      const innerTx = await createSignedInnerTx(1, '100');

      expect(() =>
        innerTx.wrapInFeeBump({
          feeSource: SPONSOR,
          baseFee: 100.5,
        }),
      ).toThrow(/baseFee must be a safe integer/);
    });

    it('rejects zero, negative, malformed, and scientific notation strings', async () => {
      const innerTx = await createSignedInnerTx(1, '100');
      const invalidInputs = [
        '0',
        '-100',
        '100.5',
        'abc',
        '',
        '   ',
        '1e5',
        '0x64',
        NaN,
        Infinity,
        -50,
        0,
        {},
        [],
      ];

      for (const input of invalidInputs) {
        expect(() =>
          innerTx.wrapInFeeBump({
            feeSource: SPONSOR,
            baseFee: input as any,
          }),
        ).toThrow(TxBuilderValidationError);
      }
    });
  });

  // ── 3. Signing Behavior ───────────────────────────────────────────────────
  describe('Signing Behavior', () => {
    it('signs outer envelope with fee-source keypair', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });

      expect(feeBump.signatures.length).toBe(0);
      feeBump.sign(SPONSOR);

      expect(feeBump.signatures.length).toBe(1);
      expect(feeBump.innerSignatures.length).toBe(1);

      // Verify cryptographic validity against outer hash
      const sigObj = feeBump.signatures[0];
      const sigBuf = Buffer.from(sigObj.signature, 'hex');
      const outerHashBuf = Buffer.from(feeBump.hash(), 'hex');
      expect(SPONSOR.verify(outerHashBuf, sigBuf)).toBe(true);
    });

    it('treats duplicate outer signatures as a safe no-op', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });

      feeBump.sign(SPONSOR);
      expect(feeBump.signatures.length).toBe(1);
      const xdrAfterFirst = feeBump.toXDR();

      feeBump.sign(SPONSOR);
      expect(feeBump.signatures.length).toBe(1);
      expect(feeBump.toXDR()).toBe(xdrAfterFirst);
    });

    it('preserves inner signatures unchanged when adding outer signatures', async () => {
      const innerTx = await createSignedInnerTx();
      const innerSigHex = innerTx.signatures[0].signature;
      const innerHashHex = innerTx.hash();

      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);
      feeBump.sign(SPONSOR_2);

      expect(feeBump.innerSignatures.length).toBe(1);
      expect(feeBump.innerSignatures[0].signature).toBe(innerSigHex);
      expect(feeBump.innerHash()).toBe(innerHashHex);
    });

    it('maintains outer and inner hash stability across outer co-signing', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });

      const outerHashInitial = feeBump.hash();
      const innerHashInitial = feeBump.innerHash();

      feeBump.sign(SPONSOR);
      expect(feeBump.hash()).toBe(outerHashInitial);
      expect(feeBump.innerHash()).toBe(innerHashInitial);

      feeBump.sign(SPONSOR_2);
      expect(feeBump.hash()).toBe(outerHashInitial);
      expect(feeBump.innerHash()).toBe(innerHashInitial);
      expect(feeBump.signatures.length).toBe(2);
    });

    it('enforces independent 20-signature limit on outer envelope', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });

      // Add 20 unique signers to outer envelope
      const signers: Keypair[] = [];
      for (let i = 0; i < 20; i++) {
        const kp = Keypair.random();
        signers.push(kp);
        feeBump.sign(kp);
      }
      expect(feeBump.signatures.length).toBe(20);
      const xdrAt20 = feeBump.toXDR();

      // 21st signature attempt must throw
      const extraSigner = Keypair.random();
      expect(() => feeBump.sign(extraSigner)).toThrow(TxBuilderValidationError);
      expect(() => feeBump.sign(extraSigner)).toThrow(/maximum limit of 20 signatures reached/);

      // Verify no partial mutation occurred
      expect(feeBump.signatures.length).toBe(20);
      expect(feeBump.toXDR()).toBe(xdrAt20);
    });

    it('rejects invalid keypair without partial mutation', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });

      expect(() => feeBump.sign(null as any)).toThrow(TxBuilderValidationError);
      expect(() => feeBump.sign({} as any)).toThrow(TxBuilderValidationError);
      expect(feeBump.signatures.length).toBe(0);
    });

    it('provides deeply readonly signatures and innerSignatures arrays', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);

      const sigs = feeBump.signatures;
      const innerSigs = feeBump.innerSignatures;

      expect(Object.isFrozen(sigs)).toBe(true);
      expect(Object.isFrozen(sigs[0])).toBe(true);
      expect(Object.isFrozen(innerSigs)).toBe(true);
      expect(Object.isFrozen(innerSigs[0])).toBe(true);

      expect(() => {
        (sigs as any).push({ hint: 'abc', signature: 'def' });
      }).toThrow();

      expect(() => {
        (sigs[0] as any).signature = 'mutated';
      }).toThrow();
    });
  });

  // ── 4. Serialization & XDR Deserialization ───────────────────────────────
  describe('Serialization & XDR Deserialization', () => {
    it('round-trips a fee-bump envelope through XDR with multiple inner and outer signatures', async () => {
      const innerTx = await createSignedInnerTx();
      // Add a second inner signer
      const innerPartyB = Keypair.random();
      innerTx.sign(innerPartyB);
      expect(innerTx.signatures.length).toBe(2);

      const feeBump = innerTx.wrapInFeeBump({
        feeSource: SPONSOR,
        baseFee: '250',
      });
      feeBump.sign(SPONSOR);
      feeBump.sign(SPONSOR_2);
      expect(feeBump.signatures.length).toBe(2);

      const xdrString = feeBump.toXDR();

      // Restore via FeeBumpBuiltTransaction.fromXDR
      const restored = FeeBumpBuiltTransaction.fromXDR(xdrString, { network: 'testnet' });

      expect(restored.feeSource).toBe(SPONSOR.publicKey());
      expect(restored.fee).toBe('500'); // 250 * 2
      expect(restored.innerSource).toBe(MOCK_SOURCE.publicKey());
      expect(restored.signatures.length).toBe(2);
      expect(restored.innerSignatures.length).toBe(2);

      expect(restored.hash()).toBe(feeBump.hash());
      expect(restored.innerHash()).toBe(feeBump.innerHash());
      expect(restored.toXDR()).toBe(xdrString);
      expect(restored.innerToXDR()).toBe(feeBump.innerToXDR());

      // Cryptographically verify restored outer signatures
      const outerHash = Buffer.from(restored.hash(), 'hex');
      expect(SPONSOR.verify(outerHash, Buffer.from(restored.signatures[0].signature, 'hex'))).toBe(
        true,
      );
      expect(
        SPONSOR_2.verify(outerHash, Buffer.from(restored.signatures[1].signature, 'hex')),
      ).toBe(true);
    });

    it('restores using networkPassphrase directly in options', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);

      const restored = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
        networkPassphrase: Networks.TESTNET,
      });

      expect(restored.feeSource).toBe(SPONSOR.publicKey());
      expect(restored.hash()).toBe(feeBump.hash());
    });

    it('preserves M-address (muxed account) fee source across XDR round-trip with valid outer signature', async () => {
      const innerTx = await createSignedInnerTx();
      const muxed = new MuxedAccount(new Account(SPONSOR.publicKey(), '1'), '12345');
      const muxedAddress = muxed.accountId();
      expect(muxedAddress.startsWith('M')).toBe(true);

      const feeBump = innerTx.wrapInFeeBump({
        feeSource: muxedAddress,
        baseFee: '200',
      });
      feeBump.sign(SPONSOR);
      expect(feeBump.signatures.length).toBe(1);

      const xdrString = feeBump.toXDR();

      // Restore via FeeBumpBuiltTransaction.fromXDR
      const restored = FeeBumpBuiltTransaction.fromXDR(xdrString, { network: 'testnet' });

      // Assert restored feeSource is exactly the original M-address
      expect(restored.feeSource).toBe(muxedAddress);
      expect(restored.feeSource.startsWith('M')).toBe(true);

      // Assert outer signature is preserved and verifies cryptographically against restored outer hash
      expect(restored.signatures.length).toBe(1);
      const outerHash = Buffer.from(restored.hash(), 'hex');
      const outerSig = Buffer.from(restored.signatures[0].signature, 'hex');
      expect(SPONSOR.verify(outerHash, outerSig)).toBe(true);

      // Assert restored XDR retains the muxed fee-source representation
      const env = xdr.TransactionEnvelope.fromXDR(restored.toXDR(), 'base64');
      const feeSourceXdr = env.feeBump().tx().feeSource();
      expect(feeSourceXdr.switch().value).toBe(xdr.CryptoKeyType.keyTypeMuxedEd25519().value);
      expect(feeSourceXdr.switch().name).toBe('keyTypeMuxedEd25519');
      expect(feeSourceXdr.med25519().id().toString()).toBe('12345');
      expect(restored.toXDR()).toBe(xdrString);
    });

    describe('Horizon URL Inference in FeeBumpBuiltTransaction.fromXDR', () => {
      it('infers mainnet Horizon URL when networkPassphrase is Networks.PUBLIC and network/horizonUrl are omitted', async () => {
        const innerTx = await createSignedInnerTx();
        const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
        feeBump.sign(SPONSOR);

        FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
          networkPassphrase: Networks.PUBLIC,
        });

        expect(Horizon.Server).toHaveBeenLastCalledWith('https://horizon.stellar.org');
      });

      it('infers testnet Horizon URL when networkPassphrase is Networks.TESTNET and network/horizonUrl are omitted', async () => {
        const innerTx = await createSignedInnerTx();
        const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
        feeBump.sign(SPONSOR);

        FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
          networkPassphrase: Networks.TESTNET,
        });

        expect(Horizon.Server).toHaveBeenLastCalledWith('https://horizon-testnet.stellar.org');
      });

      it('accepts matching network and networkPassphrase combinations', async () => {
        const innerTx = await createSignedInnerTx();
        const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
        feeBump.sign(SPONSOR);

        // Mainnet + Mainnet passphrase
        FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
          network: 'mainnet',
          networkPassphrase: Networks.PUBLIC,
        });
        expect(Horizon.Server).toHaveBeenLastCalledWith('https://horizon.stellar.org');

        // Testnet + Testnet passphrase
        FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
          network: 'testnet',
          networkPassphrase: Networks.TESTNET,
        });
        expect(Horizon.Server).toHaveBeenLastCalledWith('https://horizon-testnet.stellar.org');
      });

      it('rejects contradictory network and networkPassphrase options', async () => {
        const innerTx = await createSignedInnerTx();
        const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
        feeBump.sign(SPONSOR);

        // Mainnet + Testnet passphrase (must reject)
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'mainnet',
            networkPassphrase: Networks.TESTNET,
          }),
        ).toThrow(TxBuilderValidationError);
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'mainnet',
            networkPassphrase: Networks.TESTNET,
          }),
        ).toThrow(/Conflicting network \("mainnet"\) and networkPassphrase/);

        // Testnet + Mainnet passphrase (must reject)
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'testnet',
            networkPassphrase: Networks.PUBLIC,
          }),
        ).toThrow(TxBuilderValidationError);
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'testnet',
            networkPassphrase: Networks.PUBLIC,
          }),
        ).toThrow(/Conflicting network \("testnet"\) and networkPassphrase/);

        // Explicit horizonUrl with contradictory network options (must reject)
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'mainnet',
            networkPassphrase: Networks.TESTNET,
            horizonUrl: 'https://custom-horizon.example.com',
          }),
        ).toThrow(TxBuilderValidationError);
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'mainnet',
            networkPassphrase: Networks.TESTNET,
            horizonUrl: 'https://custom-horizon.example.com',
          }),
        ).toThrow(/Conflicting network \("mainnet"\) and networkPassphrase/);
      });

      it('explicit horizonUrl takes precedence when network options are consistent', async () => {
        const innerTx = await createSignedInnerTx();
        const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
        feeBump.sign(SPONSOR);

        const customUrl = 'https://custom-horizon.example.com';
        FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
          network: 'testnet',
          networkPassphrase: Networks.TESTNET,
          horizonUrl: customUrl,
        });

        expect(Horizon.Server).toHaveBeenLastCalledWith(customUrl);
      });

      it('custom passphrase behavior: requires explicit horizonUrl or network', async () => {
        const innerTx = await createSignedInnerTx();
        const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
        feeBump.sign(SPONSOR);

        const customPassphrase = 'Standalone Network ; February 2017';

        // 1. Without horizonUrl or network, throws TxBuilderValidationError
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            networkPassphrase: customPassphrase,
          }),
        ).toThrow(TxBuilderValidationError);

        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            networkPassphrase: customPassphrase,
          }),
        ).toThrow(/horizonUrl is required when using a custom networkPassphrase/);

        // 2. With explicit horizonUrl, succeeds
        const customUrl = 'https://standalone-horizon.local:8000';
        const restored = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
          networkPassphrase: customPassphrase,
          horizonUrl: customUrl,
        });
        expect(Horizon.Server).toHaveBeenLastCalledWith(customUrl);
        expect(restored.feeSource).toBe(SPONSOR.publicKey());

        // 3. Custom passphrase with mismatched network name is rejected
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'testnet',
            networkPassphrase: customPassphrase,
          }),
        ).toThrow(TxBuilderValidationError);
        expect(() =>
          FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), {
            network: 'testnet',
            networkPassphrase: customPassphrase,
          }),
        ).toThrow(/Conflicting network/);
      });
    });

    it('FeeBumpBuiltTransaction.fromXDR rejects ordinary transaction XDR with descriptive message', async () => {
      const innerTx = await createSignedInnerTx();
      const ordinaryXdr = innerTx.toXDR();

      expect(() => FeeBumpBuiltTransaction.fromXDR(ordinaryXdr, { network: 'testnet' })).toThrow(
        TxBuilderValidationError,
      );

      expect(() => FeeBumpBuiltTransaction.fromXDR(ordinaryXdr, { network: 'testnet' })).toThrow(
        /Parsed envelope is an ordinary transaction, not a fee-bump transaction/,
      );
      expect(() => FeeBumpBuiltTransaction.fromXDR(ordinaryXdr, { network: 'testnet' })).toThrow(
        /BuiltTransaction\.fromXDR\(\)/,
      );
    });

    it('BuiltTransaction.fromXDR rejects fee-bump XDR with descriptive message pointing to FeeBumpBuiltTransaction.fromXDR', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);
      const feeBumpXdr = feeBump.toXDR();

      expect(() => BuiltTransaction.fromXDR(feeBumpXdr, { network: 'testnet' })).toThrow(
        TxBuilderValidationError,
      );

      expect(() => BuiltTransaction.fromXDR(feeBumpXdr, { network: 'testnet' })).toThrow(
        /Fee-bump envelopes are not supported by BuiltTransaction\.fromXDR\(\)/,
      );
      expect(() => BuiltTransaction.fromXDR(feeBumpXdr, { network: 'testnet' })).toThrow(
        /FeeBumpBuiltTransaction\.fromXDR\(\)/,
      );
    });

    it('rejects invalid, empty, or unknown network in fromXDR', async () => {
      expect(() => FeeBumpBuiltTransaction.fromXDR('')).toThrow(TxBuilderValidationError);
      expect(() => FeeBumpBuiltTransaction.fromXDR('invalid-xdr', { network: 'testnet' })).toThrow(
        TxBuilderValidationError,
      );
      expect(() =>
        FeeBumpBuiltTransaction.fromXDR('AAAA', { network: 'invalid-net' as any }),
      ).toThrow(TxBuilderValidationError);
      expect(() => FeeBumpBuiltTransaction.fromXDR('AAAA')).toThrow(TxBuilderValidationError);
    });

    it('preserves Soroban transaction data and footprint across XDR round-trip', async () => {
      const contractId = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
      const invokeOp = Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: 'test',
            args: [],
          }),
        ),
        auth: [],
      });
      const sorobanData = new SorobanDataBuilder().setResourceFee(50000).build();

      const acc = new Account(MOCK_SOURCE.publicKey(), '100');
      const sorobanTx = new TransactionBuilder(acc, {
        fee: '200',
        networkPassphrase: Networks.TESTNET,
        sorobanData,
      })
        .addOperation(invokeOp)
        .setTimeout(30)
        .build();
      sorobanTx.sign(MOCK_SOURCE);

      const builtTx = BuiltTransaction.fromXDR(sorobanTx.toXDR(), { network: 'testnet' });
      const feeBump = builtTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);

      const restored = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), { network: 'testnet' });
      expect(restored.fee).toBe('50400');
      expect(restored.innerHash()).toBe(builtTx.hash());
      expect(restored.innerToXDR()).toBe(builtTx.toXDR());
    });
  });

  // ── 5. Submission ─────────────────────────────────────────────────────────
  describe('Submission', () => {
    it('submits the outer fee-bump envelope to Horizon', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);

      const result = await feeBump.submit();
      expect(result.successful).toBe(true);
      expect(result.ledger).toBe(12345);
      expect(result.hash).toBe(feeBump.hash());
      expect(result.resultXdr).toBeDefined();
    });

    it('throws TxBuilderSubmitError with resultCodes when Horizon rejects fee-bump submission', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);

      const errorPayload = {
        message: 'Transaction failed',
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_failed',
                operations: ['op_underfunded'],
              },
            },
          },
        },
      };

      (Horizon.Server as jest.Mock).mockImplementationOnce(() => ({
        submitTransaction: jest.fn().mockRejectedValue(errorPayload),
      }));

      const restored = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), { network: 'testnet' });
      await expect(restored.submit()).rejects.toThrow(TxBuilderSubmitError);

      (Horizon.Server as jest.Mock).mockImplementationOnce(() => ({
        submitTransaction: jest.fn().mockRejectedValue(errorPayload),
      }));
      const restored2 = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), { network: 'testnet' });
      try {
        await restored2.submit();
        fail('should have thrown TxBuilderSubmitError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(TxBuilderSubmitError);
        expect(err.resultCodes).toEqual({
          transaction: 'tx_failed',
          operations: ['op_underfunded'],
        });
        expect(err.message).toBe('Transaction failed');
      }
    });

    it('throws TxBuilderNetworkError when network connection fails during fee-bump submission', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      feeBump.sign(SPONSOR);

      const networkError = new Error('getaddrinfo ENOTFOUND horizon-testnet.stellar.org');

      (Horizon.Server as jest.Mock).mockImplementationOnce(() => ({
        submitTransaction: jest.fn().mockRejectedValue(networkError),
      }));

      const restored = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), { network: 'testnet' });
      await expect(restored.submit()).rejects.toThrow(TxBuilderNetworkError);

      (Horizon.Server as jest.Mock).mockImplementationOnce(() => ({
        submitTransaction: jest.fn().mockRejectedValue(networkError),
      }));
      const restored2 = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), { network: 'testnet' });
      try {
        await restored2.submit();
        fail('should have thrown TxBuilderNetworkError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(TxBuilderNetworkError);
        expect(err.message).toBe('getaddrinfo ENOTFOUND horizon-testnet.stellar.org');
      }

      // Test fallback message when error message is empty
      (Horizon.Server as jest.Mock).mockImplementationOnce(() => ({
        submitTransaction: jest.fn().mockRejectedValue(new Error('')),
      }));
      const restored3 = FeeBumpBuiltTransaction.fromXDR(feeBump.toXDR(), { network: 'testnet' });
      try {
        await restored3.submit();
        fail('should have thrown TxBuilderNetworkError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(TxBuilderNetworkError);
        expect(err.message).toBe('Network error during submission');
      }
    });
  });

  // ── 6. Deprecation & Backwards Compatibility ──────────────────────────────
  describe('Deprecation & Backwards Compatibility', () => {
    it('TxBuilder.prototype.wrapInFeeBump throws deprecated error explaining post-build workflow', () => {
      const builder = TxBuilder.for(MOCK_SOURCE, { network: 'testnet' });

      expect(() => builder.wrapInFeeBump(SPONSOR.publicKey())).toThrow(
        /TxBuilder\.wrapInFeeBump\(\) is deprecated/,
      );
      expect(() => builder.wrapInFeeBump(SPONSOR.publicKey())).toThrow(
        /Fee-bump wrapping must be performed on a signed built transaction/,
      );
    });

    it('proves legacy 4-member BuiltTransaction implementers compile and function', () => {
      // Old-style consumer implementing strictly the original 4 members
      class LegacyBuiltTransactionConsumer implements IBuiltTransaction {
        xdr = 'AAAA';
        sign(_kp: Keypair): IBuiltTransaction {
          return this;
        }
        async submit() {
          return { hash: 'h', ledger: 1, successful: true, resultXdr: 'x' };
        }
        toXDR() {
          return this.xdr;
        }
      }

      const legacy = new LegacyBuiltTransactionConsumer();
      expect(legacy.xdr).toBe('AAAA');
      expect(legacy.toXDR()).toBe('AAAA');
      expect(legacy.sign(SPONSOR)).toBe(legacy);
    });

    it('proves InspectableBuiltTransaction is assignable to BuiltTransaction', async () => {
      const inspectable: InspectableBuiltTransaction = await createSignedInnerTx();
      const base: IBuiltTransaction = inspectable;
      expect(base.xdr).toBeDefined();
      expect(typeof base.toXDR).toBe('function');
    });

    it('proves FeeBumpBuiltTransaction is assignable to BuiltTransaction', async () => {
      const innerTx = await createSignedInnerTx();
      const feeBump: IFeeBumpBuiltTransaction = innerTx.wrapInFeeBump({ feeSource: SPONSOR });
      const base: IBuiltTransaction = feeBump;
      expect(base.xdr).toBeDefined();
      expect(typeof base.toXDR).toBe('function');
      expect(typeof base.submit).toBe('function');
    });
  });
});
