import { BadRequestException } from '@nestjs/common';
import {
  addMonths,
  checkSerialFormat,
  normalizeSerial,
  normalizeSerialList,
} from './serial';

describe('serial normalization', () => {
  it('trims, strips scanner control characters and uppercases the key', () => {
    expect(normalizeSerial('  sn0a12345\r\n')).toEqual({
      serialNumber: 'sn0a12345',
      serialKey: 'SN0A12345',
    });
    expect(normalizeSerial('\u001dAB-12/34\t')).toEqual({
      serialNumber: 'AB-12/34',
      serialKey: 'AB-12/34',
    });
  });

  it('drops internal whitespace from the key but keeps it readable', () => {
    expect(normalizeSerial('SN 0A  123')).toEqual({
      serialNumber: 'SN 0A 123',
      serialKey: 'SN0A123',
    });
  });

  it('rejects empty, short, long and odd-character values', () => {
    expect(checkSerialFormat('   ')).toEqual({ ok: false, problem: 'EMPTY' });
    expect(checkSerialFormat('ab')).toEqual({
      ok: false,
      problem: 'TOO_SHORT',
    });
    expect(checkSerialFormat('A'.repeat(65))).toEqual({
      ok: false,
      problem: 'TOO_LONG',
    });
    expect(checkSerialFormat('SN<script>')).toEqual({
      ok: false,
      problem: 'BAD_CHARACTERS',
    });
    expect(checkSerialFormat('=cmd|1')).toEqual({
      ok: false,
      problem: 'BAD_CHARACTERS',
    });
    expect(() => normalizeSerial('x')).toThrow(BadRequestException);
  });

  it('rejects duplicates in one list regardless of case/spacing', () => {
    expect(() => normalizeSerialList(['abc123', 'ABC 123'])).toThrow(
      /more than once/,
    );
    expect(normalizeSerialList(['abc123', 'abc124'])).toHaveLength(2);
  });

  it('caps the list size', () => {
    const many = Array.from({ length: 501 }, (_, i) => `SN${i + 1000}`);
    expect(() => normalizeSerialList(many)).toThrow(/At most 500/);
  });
});

describe('addMonths', () => {
  it('adds months and clamps to month end', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addMonths(new Date('2026-10-10T00:00:00Z'), 12).toISOString()).toBe(
      '2027-10-10T00:00:00.000Z',
    );
  });
});
