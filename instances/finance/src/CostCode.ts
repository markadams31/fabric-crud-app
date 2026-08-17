import { authenticated, boolean, entity, text, uuid } from '@microsoft/rayfin-core';
import { Audited, AUDIT_IMMUTABLE } from '@app/shared';

/** Where a cost lands in the chart of accounts. */
@entity()
@authenticated(['read', 'create', 'delete'])
@authenticated('update', { exclude: [...AUDIT_IMMUTABLE] })
export class CostCode extends Audited() {
  @uuid() id!: string;
  @text({ min: 1, max: 10, unique: true, regex: /^[A-Z0-9-]+$/ }) code!: string;
  @text({ max: 100 }) description!: string;
  @boolean({ default: true }) isActive!: boolean;
  @text({ max: 200, optional: true }) note?: string;
}
