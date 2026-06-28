import {
  MarketplaceError,
  type FetchOrdersPage,
  type FetchOrdersParams,
  type MarketplaceAdapter,
  type MarketplaceId,
  type SellerCredential,
} from "../marketplace.js";

/**
 * 네이버 스마트스토어 (Naver Commerce API) adapter — STUB.
 *
 * This establishes the shape only. The real auth (electronic signature ->
 * OAuth2 client_credentials token), pagination, rate-limit handling, and order
 * field mapping are implemented in ENG-Naver-Spike. No real seller credentials
 * are used here.
 */
export class NaverSmartstoreAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = "naver_smartstore";

  async verifyCredential(_cred: SellerCredential): Promise<boolean> {
    throw new MarketplaceError("NaverSmartstoreAdapter is not implemented yet", {
      marketplace: this.id,
      retryable: false,
    });
  }

  async fetchOrders(
    _cred: SellerCredential,
    _params: FetchOrdersParams,
  ): Promise<FetchOrdersPage> {
    // ENG-Naver-Spike: GET /external/v1/pay-order/seller/product-orders
    // with token auth, paging by lastChangedFrom/To windows.
    throw new MarketplaceError("NaverSmartstoreAdapter is not implemented yet", {
      marketplace: this.id,
      retryable: false,
    });
  }
}
