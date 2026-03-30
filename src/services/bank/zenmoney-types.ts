// ZenMoney type definitions — local copy of types from ZenPlugins submodule.
// The submodule is not available in CI, so we maintain these locally.

export enum AccountType {
  cash = 'cash',
  ccard = 'ccard',
  checking = 'checking',
  deposit = 'deposit',
  loan = 'loan',
  investment = 'investment',
}

export interface AccountReferenceById {
  id: string;
}

export interface AccountReferenceByData {
  type: AccountType | null;
  instrument: string;
  company: {
    id: string;
  } | null;
  syncIds: string[] | null;
}

export interface Amount {
  sum: number;
  instrument: string;
}

export interface Location {
  latitude: number;
  longitude: number;
}

export interface Merchant {
  country: string | null;
  city: string | null;
  title: string;
  mcc: number | null;
  location: Location | null;
  category?: string;
}

export interface NonParsedMerchant {
  fullTitle: string;
  mcc: number | null;
  location: Location | null;
  category?: string;
}

export interface Movement {
  id: string | null;
  account: AccountReferenceById | AccountReferenceByData;
  invoice: Amount | null;
  sum: number | null;
  fee: number;
}

export interface Transaction {
  hold: boolean | null;
  date: Date;
  movements: [Movement] | [Movement, Movement];
  merchant: Merchant | NonParsedMerchant | null;
  comment: string | null;
}
