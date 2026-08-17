import { authenticated, boolean, date, decimal, entity, one, text, uuid } from '@microsoft/rayfin-core';
import { describe, expect, it } from 'vitest';

import { describeEntityClass } from './entity';

/**
 * The fork promise, tested one layer lower than `forkability.test.ts`.
 *
 * That file hand-builds `EntityView`s, so it exercises the CONSUMERS of the
 * metadata layer. But a fork does not write `EntityView`s — it writes decorated
 * classes, and `describeEntity` derives the view. Every guard that keeps a
 * hostile schema from producing a broken UI lives in that derivation, and none
 * of it was ever run against anything but the four friendly samples.
 *
 * The classes below are declared here rather than registered, so this file
 * stays fork-safe: delete the sample schema and it still runs.
 */

const describeClass = (cls: unknown) =>
  describeEntityClass(cls as never, 'Synthetic');

describe('an entity with no date column', () => {
  @entity()
  @authenticated('*')
  class Dateless {
    @uuid() id!: string;
    @text({ max: 20 }) code!: string;
  }

  it('still orders by something total, so a cursor walk cannot repeat rows', () => {
    const v = describeClass(Dateless);
    // The failure this pins: `undefined` here meant no ORDER BY at all, and
    // every `Load more` and every lookup walk paged an unordered set.
    expect(v.orderBy).toBeDefined();
    expect(Object.keys(v.orderBy)).toContain('id');
  });
});

describe('an entity with a date column', () => {
  @entity()
  @authenticated('*')
  class Dated {
    @uuid() id!: string;
    @date() openedOn!: Date;
  }

  it('sorts newest-first but still ends in the key', () => {
    const v = describeClass(Dated);
    expect(v.orderBy.openedOn).toBe('desc');
    // Without the tiebreak a shared timestamp is a tie, and seed.mjs stamps
    // every row from one `new Date()`.
    expect(v.orderBy.id).toBe('asc');
  });
});

describe('an entity that forgets its primary key', () => {
  @entity()
  @authenticated('*')
  class Keyless {
    @text({ max: 20 }) code!: string;
  }

  it('fails loudly instead of rendering a grid whose rows share one key', () => {
    expect(() => describeClass(Keyless)).toThrow(/does not declare its id column/i);
  });
});

describe('a relationship whose target is not registered', () => {
  @entity()
  @authenticated('*')
  class Unregistered {
    @uuid() id!: string;
    @text({ max: 10 }) code!: string;
  }
  @entity()
  @authenticated('*')
  class Pointing {
    @uuid() id!: string;
    @one(() => Unregistered) target?: Unregistered;
  }

  it('is skipped rather than rendered as a broken picker', () => {
    // Deliberate: an unregistered target has no client to read it with, so it
    // yields no lookup column. Worth pinning because it also means the
    // declared-FK guard cannot fire for such a target — the safety net for a
    // forgotten registration is instances.test.ts, which catches the entity FILE.
    const v = describeClass(Pointing);
    expect(v.columns.map((f) => f.name)).not.toContain('target_id');
    expect(v.fields.some((f) => f.lookup)).toBe(false);
  });
});

describe('field-level grants', () => {
  @entity()
  @authenticated(['read', 'delete'])
  @authenticated('create', { exclude: ['owner'] })
  @authenticated('update', { exclude: ['code'] })
  class Restricted {
    @uuid() id!: string;
    @text({ max: 10 }) code!: string;
    @text({ max: 50 }) owner!: string;
    @boolean() active!: boolean;
  }

  it('creating and editing each offer only what their own grant permits', () => {
    const v = describeClass(Restricted);
    expect(v.creatable.map((f) => f.name)).not.toContain('owner');
    expect(v.creatable.map((f) => f.name)).toContain('code');
    expect(v.updatable.map((f) => f.name)).not.toContain('code');
    expect(v.updatable.map((f) => f.name)).toContain('owner');
  });

  it('reports the write actions the decorators actually grant', () => {
    const v = describeClass(Restricted);
    expect(v.can).toEqual({ create: true, update: true, delete: true });
  });
});

describe('a read-only entity', () => {
  @entity()
  @authenticated(['read'])
  class ReadOnly {
    @uuid() id!: string;
    @text({ max: 10 }) code!: string;
  }

  it('grants no writes, so the grid offers no New, Edit or Delete', () => {
    expect(describeClass(ReadOnly).can).toEqual({
      create: false,
      update: false,
      delete: false,
    });
  });
});

describe('a decimal without a declared scale', () => {
  @entity()
  @authenticated('*')
  class Money {
    @uuid() id!: string;
    @decimal() amount!: number;
  }

  it('is still a scale-2 column, which is why validate.ts must assume one', () => {
    const v = describeClass(Money);
    const amount = v.fields.find((f) => f.name === 'amount')!;
    // The SDK reports no scale when none was declared — the trap that let a
    // bare @decimal() slip past the truncation gate.
    expect(amount.constraints.type).toBe('number');
  });
});
