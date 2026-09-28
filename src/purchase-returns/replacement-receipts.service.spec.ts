import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import {
  ReplacementReceiptsService,
  withReplacementSummary,
} from './replacement-receipts.service';
import { supplierBalance } from '../common/utils/supplier-balance';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';

const D = (v: number | string) => new Prisma.Decimal(v);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('supplierBalance', () => {
  const base = {
    purchases: D(10000),
    transportCharges: D(0),
    returns: D(0),
    replacements: D(0),
    settled: D(0),
  };

  it('is unchanged for suppliers with no replacements (old formula)', () => {
    const c = {
      ...base,
      returns: D(500),
      settled: D(2000),
      transportCharges: D(150),
    };
    expect(supplierBalance(c).toString()).toBe(
      D(10000).sub(500).sub(2000).sub(150).toString(),
    );
  });

  it('a full replacement exactly reverses the return', () => {
    const afterReturn = supplierBalance({ ...base, returns: D(1000) });
    const afterReplacement = supplierBalance({
      ...base,
      returns: D(1000),
      replacements: D(1000),
    });
    expect(afterReturn.toString()).toBe('9000');
    expect(afterReplacement.toString()).toBe('10000');
  });
});

describe('withReplacementSummary', () => {
  const ret = (replacements: { qty: number; amount: number }[]) => ({
    totalAmount: D(1000),
    items: [{ id: 'ri-1', quantity: 10 }],
    replacements: replacements.map((r) => ({
      totalAmount: D(r.amount),
      items: [{ purchaseReturnItemId: 'ri-1', quantity: r.qty }],
    })),
  });

  it('old returns with no receipts read as NOT_REPLACED', () => {
    const s = withReplacementSummary(ret([]));
    expect(s.replacementStatus).toBe('NOT_REPLACED');
    expect(s.items[0].remainingQuantity).toBe(10);
    expect(s.receivedAmount.toString()).toBe('0');
  });

  it('sums multiple receipts → PARTIAL then FULL', () => {
    expect(
      withReplacementSummary(ret([{ qty: 4, amount: 400 }])).replacementStatus,
    ).toBe('PARTIAL');
    const full = withReplacementSummary(
      ret([
        { qty: 4, amount: 400 },
        { qty: 6, amount: 600 },
      ]),
    );
    expect(full.replacementStatus).toBe('FULL');
    expect(full.items[0].receivedQuantity).toBe(10);
    expect(full.items[0].remainingQuantity).toBe(0);
    expect(full.receivedAmount.toString()).toBe('1000');
  });
});

describe('ReplacementReceiptsService', () => {
  const RETURN_ID = 'ret-1';
  const KEY = '11111111-1111-4111-8111-111111111111';

  let service: ReplacementReceiptsService;
  let tx: {
    $queryRaw: jest.Mock;
    purchaseReturn: { findUniqueOrThrow: jest.Mock };
    purchaseReturnReplacement: {
      findUnique: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      delete: jest.Mock;
      update: jest.Mock;
    };
    purchaseReturnReplacementItem: { deleteMany: jest.Mock };
    counter: { upsert: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    purchaseReturnReplacement: { findUnique: jest.Mock };
  };
  let inventory: { recordMovement: jest.Mock };
  let activityLog: { log: jest.Mock };
  let overReceivedRows: { id: string }[];

  function returnWith(alreadyReceived: number[]) {
    return {
      id: RETURN_ID,
      returnNumber: 'PRTN-2026-00012',
      supplierId: 'sup-1',
      supplier: { name: 'Acme' },
      returnDate: new Date('2026-09-01T00:00:00Z'),
      items: [
        {
          id: 'ri-1',
          productId: 'prod-1',
          quantity: 10,
          unitCost: D(100),
          replacementItems: alreadyReceived.map((quantity) => ({
            replacementId: 'rep-other',
            quantity,
          })),
        },
      ],
    };
  }

  // Two lines (different products/costs); `received` maps replacementId →
  // qty already received on ri-1.
  function twoLineReturn(received: Record<string, number>) {
    return {
      ...returnWith([]),
      items: [
        {
          id: 'ri-1',
          productId: 'prod-1',
          quantity: 10,
          unitCost: D(100),
          replacementItems: Object.entries(received).map(
            ([replacementId, quantity]) => ({ replacementId, quantity }),
          ),
        },
        {
          id: 'ri-2',
          productId: 'prod-2',
          quantity: 5,
          unitCost: D(250),
          replacementItems: [],
        },
      ],
    };
  }

  interface CreatedData {
    totalAmount: Prisma.Decimal;
    supplierId: string;
    replacementNumber: string;
    items: {
      create: {
        purchaseReturnItemId: string;
        productId: string;
        quantity: number;
        unitCost: Prisma.Decimal;
      }[];
    };
  }
  const createdData = () =>
    (
      tx.purchaseReturnReplacement.create.mock.calls[0] as [
        { data: CreatedData },
      ]
    )[0].data;

  const dto = (quantity: number, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: KEY,
    receivedDate: '2026-09-20',
    items: [{ purchaseReturnItemId: 'ri-1', quantity, ...extra }],
  });

  beforeEach(() => {
    overReceivedRows = [];
    tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('').includes('FOR UPDATE')
            ? [{ id: RETURN_ID }]
            : overReceivedRows,
        ),
      ),
      purchaseReturn: { findUniqueOrThrow: jest.fn() },
      purchaseReturnReplacement: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'rep-1', ...args.data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'rep-1', ...args.data }),
        ),
      },
      purchaseReturnReplacementItem: { deleteMany: jest.fn() },
      counter: { upsert: jest.fn().mockResolvedValue({ value: 21 }) },
    };
    prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
      purchaseReturnReplacement: { findUnique: jest.fn() },
    };
    inventory = { recordMovement: jest.fn().mockResolvedValue({}) };
    activityLog = { log: jest.fn() };
    service = new ReplacementReceiptsService(
      prisma as unknown as PrismaService,
      inventory as unknown as InventoryService,
      activityLog as unknown as ActivityLogService,
    );
  });

  describe('create', () => {
    it('locks the return, prices from the return line, restocks via recordMovement, logs', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([]));

      await service.create(RETURN_ID, dto(4), 'admin-1');

      const lockSql = (tx.$queryRaw.mock.calls[0] as [string[]])[0].join('');
      expect(lockSql).toContain('FOR UPDATE');
      const data = createdData();
      expect(data.totalAmount.toString()).toBe('400');
      expect(data.supplierId).toBe('sup-1');
      expect(data.replacementNumber).toMatch(/^RPLC-\d{4}-00021$/);
      expect(data.items.create[0]).toMatchObject({
        purchaseReturnItemId: 'ri-1',
        productId: 'prod-1',
        quantity: 4,
      });
      expect(inventory.recordMovement).toHaveBeenCalledWith(tx, {
        productId: 'prod-1',
        type: InventoryLogType.ADJUSTMENT,
        quantityIn: 4,
        reference: 'rep-1',
      });
      expect(activityLog.log).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ action: 'RECORDED_REPLACEMENT_RECEIPT' }),
      );
    });

    it('ignores a client-supplied unitCost/productId', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([]));
      await service.create(
        RETURN_ID,
        dto(2, { unitCost: 1, productId: 'other' }),
        'admin-1',
      );
      const line = createdData().items.create[0];
      expect(line.unitCost.toString()).toBe('100');
      expect(line.productId).toBe('prod-1');
    });

    it('rejects receiving more than remains across earlier receipts', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([4, 3]));
      await expect(service.create(RETURN_ID, dto(4), 'a')).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.purchaseReturnReplacement.create).not.toHaveBeenCalled();
      expect(inventory.recordMovement).not.toHaveBeenCalled();
    });

    it('sums duplicate lines for the same return item before checking the cap', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([5]));
      await expect(
        service.create(
          RETURN_ID,
          {
            ...dto(3),
            items: [
              { purchaseReturnItemId: 'ri-1', quantity: 3 },
              { purchaseReturnItemId: 'ri-1', quantity: 3 },
            ],
          },
          'a',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a line from another return', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([]));
      await expect(
        service.create(
          RETURN_ID,
          { ...dto(1), items: [{ purchaseReturnItemId: 'x', quantity: 1 }] },
          'a',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a received date before the return date', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([]));
      await expect(
        service.create(
          RETURN_ID,
          { ...dto(1), receivedDate: '2026-08-31' },
          'a',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s for an unknown return', async () => {
      tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(service.create(RETURN_ID, dto(1), 'a')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('is idempotent: a resent key returns the existing receipt with no side effects', async () => {
      const existing = { id: 'rep-1', purchaseReturnId: RETURN_ID };
      tx.purchaseReturnReplacement.findUnique.mockResolvedValue(existing);

      await expect(service.create(RETURN_ID, dto(4), 'a')).resolves.toBe(
        existing,
      );
      expect(tx.counter.upsert).not.toHaveBeenCalled();
      expect(tx.purchaseReturnReplacement.create).not.toHaveBeenCalled();
      expect(inventory.recordMovement).not.toHaveBeenCalled();
    });

    it('rejects a key reused for a different return', async () => {
      tx.purchaseReturnReplacement.findUnique.mockResolvedValue({
        id: 'rep-9',
        purchaseReturnId: 'other-return',
      });
      await expect(service.create(RETURN_ID, dto(1), 'a')).rejects.toThrow(
        ConflictException,
      );
    });

    it('resolves a unique-key race to the winning receipt', async () => {
      const winner = { id: 'rep-1', purchaseReturnId: RETURN_ID };
      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      prisma.purchaseReturnReplacement.findUnique.mockResolvedValue(winner);
      await expect(service.create(RETURN_ID, dto(1), 'a')).resolves.toBe(
        winner,
      );
    });

    it('propagates a stock failure so the transaction rolls back', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([]));
      inventory.recordMovement.mockRejectedValueOnce(new Error('stock'));
      await expect(service.create(RETURN_ID, dto(1), 'a')).rejects.toThrow(
        'stock',
      );
      expect(activityLog.log).not.toHaveBeenCalled();
    });

    it('refuses to commit if the post-write check finds an over-received line', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(returnWith([]));
      overReceivedRows = [{ id: 'ri-1' }];
      await expect(service.create(RETURN_ID, dto(1), 'a')).rejects.toThrow(
        ConflictException,
      );
      expect(activityLog.log).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const existingReceipt = (createdAt = new Date()) => ({
      id: 'rep-1',
      replacementNumber: 'RPLC-2026-00021',
      purchaseReturnId: RETURN_ID,
      totalAmount: D(400),
      createdAt,
      items: [
        { productId: 'prod-1', purchaseReturnItemId: 'ri-1', quantity: 4 },
      ],
    });
    const updateDto = (
      items: { purchaseReturnItemId: string; quantity: number }[],
    ) => ({
      receivedDate: '2026-09-20',
      items,
    });
    const updatedData = () =>
      (
        tx.purchaseReturnReplacement.update.mock.calls[0] as [
          { data: CreatedData & { items: { deleteMany: object } } },
        ]
      )[0].data;

    beforeEach(() => {
      prisma.purchaseReturnReplacement.findUnique.mockResolvedValue({
        purchaseReturnId: RETURN_ID,
      });
      tx.purchaseReturnReplacement.findUnique.mockResolvedValue(
        existingReceipt(),
      );
    });

    it('moves units to a different product line: re-prices and moves stock by the net difference', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(
        twoLineReturn({ 'rep-1': 4 }),
      );

      await service.update(
        'rep-1',
        updateDto([{ purchaseReturnItemId: 'ri-2', quantity: 4 }]),
        'a',
      );

      const data = updatedData();
      expect(data.totalAmount.toString()).toBe('1000'); // 4 × 250, from ri-2
      expect(data.items.create[0]).toMatchObject({
        purchaseReturnItemId: 'ri-2',
        productId: 'prod-2',
        quantity: 4,
      });
      expect(inventory.recordMovement).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          productId: 'prod-1',
          quantityOut: 4,
          quantityIn: 0,
        }),
      );
      expect(inventory.recordMovement).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          productId: 'prod-2',
          quantityIn: 4,
          quantityOut: 0,
        }),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ action: 'UPDATED_REPLACEMENT_RECEIPT' }),
      );
    });

    it("corrects a count: its own old quantity doesn't count against the cap, stock moves only by the difference", async () => {
      // ri-1 returned 10; this receipt had 4, another receipt has 3 → up to 7 allowed
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(
        twoLineReturn({ 'rep-1': 4, 'rep-other': 3 }),
      );

      await service.update(
        'rep-1',
        updateDto([{ purchaseReturnItemId: 'ri-1', quantity: 6 }]),
        'a',
      );

      expect(updatedData().totalAmount.toString()).toBe('600');
      expect(inventory.recordMovement).toHaveBeenCalledTimes(1);
      expect(inventory.recordMovement).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          productId: 'prod-1',
          quantityIn: 2,
          quantityOut: 0,
        }),
      );
    });

    it('rejects a correction above what other receipts leave outstanding', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(
        twoLineReturn({ 'rep-1': 4, 'rep-other': 3 }),
      );
      await expect(
        service.update(
          'rep-1',
          updateDto([{ purchaseReturnItemId: 'ri-1', quantity: 8 }]),
          'a',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.purchaseReturnReplacement.update).not.toHaveBeenCalled();
      expect(inventory.recordMovement).not.toHaveBeenCalled();
    });

    it('a date/ref-only edit moves no stock', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(
        twoLineReturn({ 'rep-1': 4 }),
      );
      await service.update(
        'rep-1',
        updateDto([{ purchaseReturnItemId: 'ri-1', quantity: 4 }]),
        'a',
      );
      expect(inventory.recordMovement).not.toHaveBeenCalled();
    });

    it('is blocked after 1 day', async () => {
      tx.purchaseReturnReplacement.findUnique.mockResolvedValue(
        existingReceipt(new Date(Date.now() - 2 * DAY_MS)),
      );
      await expect(
        service.update(
          'rep-1',
          updateDto([{ purchaseReturnItemId: 'ri-1', quantity: 4 }]),
          'a',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.purchaseReturnReplacement.update).not.toHaveBeenCalled();
    });

    it('404s for an unknown receipt', async () => {
      prisma.purchaseReturnReplacement.findUnique.mockResolvedValue(null);
      await expect(service.update('nope', updateDto([]), 'a')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to commit if the post-write check finds an over-received line', async () => {
      tx.purchaseReturn.findUniqueOrThrow.mockResolvedValue(
        twoLineReturn({ 'rep-1': 4 }),
      );
      overReceivedRows = [{ id: 'ri-1' }];
      await expect(
        service.update(
          'rep-1',
          updateDto([{ purchaseReturnItemId: 'ri-1', quantity: 5 }]),
          'a',
        ),
      ).rejects.toThrow(ConflictException);
      expect(activityLog.log).not.toHaveBeenCalled();
    });
  });

  describe('void', () => {
    const receipt = (createdAt: Date) => ({
      id: 'rep-1',
      replacementNumber: 'RPLC-2026-00021',
      purchaseReturnId: RETURN_ID,
      totalAmount: D(400),
      createdAt,
      supplier: { name: 'Acme' },
      purchaseReturn: { returnNumber: 'PRTN-2026-00012' },
      items: [{ productId: 'prod-1', quantity: 4 }],
    });

    it('takes the stock back out and deletes the receipt within 1 day', async () => {
      prisma.purchaseReturnReplacement.findUnique.mockResolvedValue(
        receipt(new Date()),
      );
      await service.void('rep-1', 'a');
      expect(inventory.recordMovement).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ productId: 'prod-1', quantityOut: 4 }),
      );
      expect(tx.purchaseReturnReplacement.delete).toHaveBeenCalledWith({
        where: { id: 'rep-1' },
      });
      expect(activityLog.log).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ action: 'VOIDED_REPLACEMENT_RECEIPT' }),
      );
    });

    it('is blocked after 1 day', async () => {
      prisma.purchaseReturnReplacement.findUnique.mockResolvedValue(
        receipt(new Date(Date.now() - 2 * DAY_MS)),
      );
      await expect(service.void('rep-1', 'a')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('fails cleanly (nothing deleted) if the units were already sold', async () => {
      prisma.purchaseReturnReplacement.findUnique.mockResolvedValue(
        receipt(new Date()),
      );
      inventory.recordMovement.mockRejectedValueOnce(
        new BadRequestException('Insufficient stock'),
      );
      await expect(service.void('rep-1', 'a')).rejects.toThrow(
        'Insufficient stock',
      );
      expect(tx.purchaseReturnReplacement.delete).not.toHaveBeenCalled();
    });
  });
});
