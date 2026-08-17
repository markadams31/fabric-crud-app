/** Sample rows for the `finance` instance. See instances/reference/seed.mjs. */
export default async function seed({ ensure, client }) {
  await ensure(
    'CostCode',
    'code',
    [
      ['FIN-100', 'Accounts payable', true],
      ['FIN-200', 'Accounts receivable', true],
      ['FIN-900', 'Suspense', false],
    ].map(([code, description, isActive]) => ({ code, description, isActive }))
  );

  await ensure(
    'Invoice',
    'reference',
    [
      ['INV-1001', 1250.5, '2026-01-15'],
      ['INV-1002', 88000, '2026-02-01'],
      ['INV-1003', 47.25, '2026-03-20'],
    ].map(([reference, amount, issuedOn]) => ({
      reference,
      amount,
      issuedOn: new Date(issuedOn),
    }))
  );
  void client;
}
