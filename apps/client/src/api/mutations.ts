/**
 * Command mutations. Each `mutate()` call is one user action → one API invocation → one
 * Idempotency-Key (generated inside the HTTP client). Mutations never retry at this level.
 * On success the affected queries are invalidated; on CONFLICT / PRICE_CHANGED the same queries
 * are refetched so the UI can explain the new state.
 */
import type {
  AcceptContractRequest,
  BuyListingRequest,
  BuyMachineryRequest,
  CommandOk,
  CreateCompanyRequest,
  CreateContractRequest,
  CreateListingRequest,
  LeaseParcelRequest,
  ListParcelRequest,
  MarkNotificationsReadRequest,
  PlantRequest,
  PlotOperationRequest,
  PurchaseParcelRequest,
  RepayLoanRequest,
  SellParcelToStateRequest,
  SellToMarketRequest,
  TakeLoanRequest,
} from '@bh/contracts';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from '../store/toasts';
import { api } from './client';
import { describeError, isStaleStateError } from './errors';
import { invalidateKeys, resourceKeys } from './queryKeys';

interface CommandOptions<V> {
  invalidate: (vars: V) => QueryKey[];
  /** Success toast text; null for none. */
  successMessage?: (vars: V, res: CommandOk) => string | null;
  /** Toast errors (default true). Dialogs that render errors inline pass false. */
  toastErrors?: boolean;
}

function useCommand<V>(fn: (vars: V) => Promise<CommandOk>, opts: CommandOptions<V>) {
  const qc = useQueryClient();
  return useMutation<CommandOk, Error, V>({
    mutationFn: fn,
    onSuccess: (res, vars) => {
      invalidateKeys(qc, opts.invalidate(vars));
      const msg = opts.successMessage?.(vars, res);
      if (msg) toast.success(msg);
    },
    onError: (err, vars) => {
      if (isStaleStateError(err)) invalidateKeys(qc, opts.invalidate(vars));
      if (opts.toastErrors ?? true) {
        const d = describeError(err);
        toast.danger(d.title, d.message);
      }
    },
  });
}

const parcelKeys = (parcelId: string): QueryKey[] => [
  ['map'],
  ['parcel', parcelId],
  ['suitability', parcelId],
  ...resourceKeys('overview', 'me', 'leaderboard', 'ledger'),
];

// --- company ---------------------------------------------------------------

export function useCreateCompany() {
  return useCommand((body: CreateCompanyRequest) => api.createCompany(body), {
    invalidate: () => resourceKeys('me', 'overview', 'map', 'leaderboard'),
    successMessage: (v) => `${v.name} is open for business`,
  });
}

// --- land ------------------------------------------------------------------

export function usePurchaseParcel(toastErrors = false) {
  return useCommand(
    (v: { parcelId: string; body: PurchaseParcelRequest }) =>
      api.purchaseParcel(v.parcelId, v.body),
    {
      invalidate: (v) => parcelKeys(v.parcelId),
      successMessage: (v) => `Parcel ${v.parcelId} is yours`,
      toastErrors,
    },
  );
}

export function useLeaseParcel(toastErrors = false) {
  return useCommand(
    (v: { parcelId: string; body: LeaseParcelRequest }) => api.leaseParcel(v.parcelId, v.body),
    {
      invalidate: (v) => parcelKeys(v.parcelId),
      successMessage: (v) => `Leased ${v.parcelId} for ${v.body.seasons} season(s)`,
      toastErrors,
    },
  );
}

export function useListParcel(toastErrors = false) {
  return useCommand(
    (v: { parcelId: string; body: ListParcelRequest }) => api.listParcel(v.parcelId, v.body),
    {
      invalidate: (v) => parcelKeys(v.parcelId),
      successMessage: (v) => `${v.parcelId} listed for sale`,
      toastErrors,
    },
  );
}

export function useDelistParcel() {
  return useCommand((v: { parcelId: string }) => api.delistParcel(v.parcelId), {
    invalidate: (v) => parcelKeys(v.parcelId),
    successMessage: (v) => `${v.parcelId} withdrawn from sale`,
  });
}

export function useSellParcelToState(toastErrors = false) {
  return useCommand(
    (v: { parcelId: string; body: SellParcelToStateRequest }) =>
      api.sellParcelToState(v.parcelId, v.body),
    {
      invalidate: (v) => parcelKeys(v.parcelId),
      successMessage: (v) => `${v.parcelId} sold to the state`,
      toastErrors,
    },
  );
}

// --- farming ---------------------------------------------------------------

export function usePlant(toastErrors = false) {
  return useCommand((body: PlantRequest) => api.plant(body), {
    invalidate: (v) => [...parcelKeys(v.parcelId), ...resourceKeys('plots')],
    successMessage: () => 'Sowing complete',
    toastErrors,
  });
}

export function usePlotOperation() {
  return useCommand(
    (v: { plotId: string; parcelId: string; body: PlotOperationRequest }) =>
      api.plotOperation(v.plotId, v.body),
    {
      invalidate: (v) => [
        ['parcel', v.parcelId],
        ...resourceKeys('plots', 'overview', 'me', 'ledger'),
      ],
      successMessage: (v) =>
        ({
          irrigation_on: 'Irrigation switched on',
          irrigation_off: 'Irrigation switched off',
          fertilize: 'Fertiliser applied',
          pest_control: 'Pest control applied',
        })[v.body.op],
    },
  );
}

export function useHarvest() {
  return useCommand((v: { plotId: string; parcelId: string }) => api.harvest(v.plotId), {
    invalidate: (v) => [
      ['map'],
      ['parcel', v.parcelId],
      ...resourceKeys('plots', 'inventory', 'overview', 'me', 'ledger'),
    ],
    successMessage: () => 'Harvest moved to storage',
  });
}

export function useClearPlot() {
  return useCommand((v: { plotId: string; parcelId: string }) => api.clearPlot(v.plotId), {
    invalidate: (v) => [['map'], ['parcel', v.parcelId], ...resourceKeys('plots', 'overview')],
    successMessage: () => 'Field cleared',
  });
}

// --- markets & trade -------------------------------------------------------

export function useSellToMarket() {
  return useCommand(
    (v: { marketId: string; body: SellToMarketRequest }) => api.sellToMarket(v.marketId, v.body),
    {
      invalidate: () =>
        resourceKeys('inventory', 'markets', 'priceHistory', 'quote', 'overview', 'me', 'ledger'),
      successMessage: () => 'Sold at the mandi',
    },
  );
}

export function useCreateListing() {
  return useCommand((body: CreateListingRequest) => api.createListing(body), {
    invalidate: () => resourceKeys('listings', 'inventory', 'overview'),
    successMessage: () => 'Listing published',
  });
}

export function useBuyListing() {
  return useCommand(
    (v: { listingId: string; body: BuyListingRequest }) => api.buyListing(v.listingId, v.body),
    {
      invalidate: () => resourceKeys('listings', 'inventory', 'overview', 'me', 'ledger'),
      successMessage: () => 'Purchase complete',
    },
  );
}

export function useCancelListing() {
  return useCommand((v: { listingId: string }) => api.cancelListing(v.listingId), {
    invalidate: () => resourceKeys('listings', 'inventory', 'overview'),
    successMessage: () => 'Listing cancelled; stock released',
  });
}

export function useCreateContract() {
  return useCommand((body: CreateContractRequest) => api.createContract(body), {
    invalidate: () => resourceKeys('contracts', 'overview', 'me', 'ledger'),
    successMessage: () => 'Contract posted; funds moved to escrow',
  });
}

export function useAcceptContract() {
  return useCommand(
    (v: { contractId: string; body: AcceptContractRequest }) =>
      api.acceptContract(v.contractId, v.body),
    {
      invalidate: () => resourceKeys('contracts', 'overview'),
      successMessage: () => 'Contract accepted',
    },
  );
}

export function useDeliverContract() {
  return useCommand((v: { contractId: string }) => api.deliverContract(v.contractId), {
    invalidate: () => resourceKeys('contracts', 'inventory', 'overview', 'me', 'ledger'),
    successMessage: () => 'Delivered; payment released from escrow',
  });
}

export function useCancelContract() {
  return useCommand((v: { contractId: string }) => api.cancelContract(v.contractId), {
    invalidate: () => resourceKeys('contracts', 'overview', 'me', 'ledger'),
    successMessage: () => 'Contract cancelled; escrow refunded',
  });
}

// --- finance ---------------------------------------------------------------

export function useTakeLoan() {
  return useCommand((body: TakeLoanRequest) => api.takeLoan(body), {
    invalidate: () => resourceKeys('loans', 'overview', 'me', 'ledger'),
    successMessage: () => 'Loan disbursed',
  });
}

export function useRepayLoan() {
  return useCommand(
    (v: { loanId: string; body: RepayLoanRequest }) => api.repayLoan(v.loanId, v.body),
    {
      invalidate: () => resourceKeys('loans', 'overview', 'me', 'ledger'),
      successMessage: () => 'Repayment recorded',
    },
  );
}

export function useBuyMachinery() {
  return useCommand((body: BuyMachineryRequest) => api.buyMachinery(body), {
    invalidate: () => resourceKeys('machinery', 'overview', 'me', 'ledger', 'inventory'),
    successMessage: () => 'Machinery purchased',
  });
}

export function useSellMachinery() {
  return useCommand((v: { assetId: string }) => api.sellMachinery(v.assetId), {
    invalidate: () => resourceKeys('machinery', 'overview', 'me', 'ledger', 'inventory'),
    successMessage: () => 'Machinery sold',
  });
}

// --- notifications & dev -----------------------------------------------------

export function useMarkNotificationsRead() {
  return useCommand((body: MarkNotificationsReadRequest) => api.markNotificationsRead(body), {
    invalidate: () => resourceKeys('notifications', 'overview'),
  });
}

export function useDevAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api.devAdvance(days),
    onSuccess: (_res, days) => {
      void qc.invalidateQueries();
      toast.info(`Advanced ${days} day${days === 1 ? '' : 's'}`);
    },
    onError: (err) => {
      const d = describeError(err);
      toast.danger(d.title, d.message);
    },
  });
}
