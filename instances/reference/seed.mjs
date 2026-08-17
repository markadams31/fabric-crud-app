/**
 * Sample rows for the `reference` instance.
 *
 * Lives beside the entities it fills, because fixtures are instance data: a
 * seeder naming `Country` cannot run against an instance that has no Country
 * (it fails with "The field `countries` does not exist on the type `Query`").
 * `scripts/seed.mjs` owns the mechanism — signing in, idempotent inserts,
 * audit stamping — and calls this.
 */
export default async function seed({ ensure, client }) {

  const currencies = [
    ['USD', 'US Dollar', '$', 2, true],
    ['EUR', 'Euro', '€', 2, true],
    ['GBP', 'Pound Sterling', '£', 2, true],
    ['JPY', 'Japanese Yen', '¥', 0, true],
    ['AUD', 'Australian Dollar', 'A$', 2, true],
    ['NZD', 'New Zealand Dollar', 'NZ$', 2, true],
    ['CAD', 'Canadian Dollar', 'C$', 2, true],
    ['CHF', 'Swiss Franc', 'CHF', 2, true],
    ['SGD', 'Singapore Dollar', 'S$', 2, true],
    ['INR', 'Indian Rupee', '₹', 2, true],
    ['NOK', 'Norwegian Krone', 'kr', 2, false],
    ['XAU', 'Gold (troy ounce)', null, 4, false],
  ].map(([code, name, symbol, decimalPlaces, isActive]) => ({
    code,
    name,
    ...(symbol ? { symbol } : {}),
    decimalPlaces,
    isActive,
  }));

  await ensure('Currency', 'code', currencies);

  // Countries carry a currency foreign key — resolve ids after the inserts.
  const currencyRows = await client.data.Currency.select(['id', 'code']).first(500).executePaginated();
  const currencyId = Object.fromEntries(currencyRows.items.map((r) => [r.code, r.id]));

  const countries = [
    ['US', 'United States', 'Americas', 334914895, true, 'USD'],
    ['AU', 'Australia', 'Asia Pacific', 26638544, true, 'AUD'],
    ['NZ', 'New Zealand', 'Asia Pacific', 5223100, true, 'NZD'],
    ['GB', 'United Kingdom', 'Europe', 68350000, true, 'GBP'],
    ['DE', 'Germany', 'Europe', 84482267, true, 'EUR'],
    ['FR', 'France', 'Europe', 68170228, true, 'EUR'],
    ['JP', 'Japan', 'Asia Pacific', 124352000, true, 'JPY'],
    ['CA', 'Canada', 'Americas', 40097761, true, 'CAD'],
    ['CH', 'Switzerland', 'Europe', 8902308, true, 'CHF'],
    ['SG', 'Singapore', 'Asia Pacific', 5917600, true, 'SGD'],
    ['IN', 'India', 'Asia Pacific', 1428627663, true, 'INR'],
    ['NO', 'Norway', 'Europe', 5550203, false, 'NOK'],
  ].map(([code, name, region, population, isActive, ccy]) => ({
    code,
    name,
    region,
    population,
    isActive,
    currency_id: currencyId[ccy],
  }));

  await ensure('Country', 'code', countries);

  await ensure(
    'UnitOfMeasure',
    'code',
    [
      ['KG', 'Kilogram', 'Mass', 1, true],
      ['G', 'Gram', 'Mass', 0.001, false],
      ['T', 'Tonne', 'Mass', 1000, false],
      ['L', 'Litre', 'Volume', 1, true],
      ['ML', 'Millilitre', 'Volume', 0.001, false],
      ['M', 'Metre', 'Length', 1, true],
      ['H', 'Hour', 'Time', 1, true],
      ['EA', 'Each', 'Count', 1, true],
    ].map(([code, name, dimension, factorToBase, isBaseUnit]) => ({
      code,
      name,
      dimension,
      factorToBase,
      isBaseUnit,
    }))
  );

  await ensure(
    'CostCentre',
    'code',
    [
      ['CC1000', 'Corporate Overheads', 'finance@contoso.com', '2022-07-01', null, 1250000],
      ['CC2000', 'Engineering', 'eng-lead@contoso.com', '2022-07-01', null, 4800000],
      ['CC2100', 'Platform Team', 'platform@contoso.com', '2023-01-15', null, 950000.5],
      ['CC3000', 'Sales ANZ', 'sales-anz@contoso.com', '2022-09-01', null, 2200000],
      ['CC4000', 'Legacy Migration', 'pmo@contoso.com', '2023-03-01', '2025-06-30', 310000.25],
      ['CC5000', 'Field Ops', 'ops@contoso.com', '2024-02-01', null, null],
    ].map(([code, name, owner, openedOn, closedOn, annualBudget]) => ({
      code,
      name,
      owner,
      openedOn: new Date(openedOn),
      ...(closedOn ? { closedOn: new Date(closedOn) } : {}),
      ...(annualBudget != null ? { annualBudget } : {}),
    }))
  );

}
