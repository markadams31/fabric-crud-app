import { authenticated, date, decimal, entity, text, uuid } from '@microsoft/rayfin-core';
import { Audited, AUDIT_IMMUTABLE } from '@app/shared';

/** A payable, priced in one of the shared currencies. */
@entity()
@authenticated(['read', 'create', 'delete'])
@authenticated('update', { exclude: [...AUDIT_IMMUTABLE] })
export class Invoice extends Audited() {
  @uuid() id!: string;
  @text({ min: 1, max: 20, unique: true }) reference!: string;
  @decimal({ precision: 18, scale: 2, min: 0 }) amount!: number;
  @date() issuedOn!: Date;
}
