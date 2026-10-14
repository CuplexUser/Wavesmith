package se.cuplex.wavesmith;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.List;

/**
 * Google Play Billing for the one-time "full game" unlock (an in-app, non-consumable product).
 *
 * JavaScript calls getProduct (price label), purchase, and restore; each resolves with
 * {@code owned}. Purchases are acknowledged here, as Play requires within three days. The game
 * is single-player and offline, so ownership is checked on the device rather than on a server.
 */
@CapacitorPlugin(name = "Billing")
public class BillingPlugin extends Plugin implements PurchasesUpdatedListener {
    private BillingClient client;
    private PluginCall pendingPurchase;
    private String pendingProduct;

    @Override
    public void load() {
        client = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build();
    }

    /** Runs {@code then} once connected, or rejects {@code call}. */
    private void connected(PluginCall call, Runnable then) {
        if (client.isReady()) {
            then.run();
            return;
        }
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    then.run();
                } else {
                    call.reject("Billing unavailable: " + result.getDebugMessage(), String.valueOf(result.getResponseCode()));
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Reconnects on the next call.
            }
        });
    }

    private void withProduct(PluginCall call, String productId, ProductCallback then) {
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(Collections.singletonList(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build()))
            .build();
        client.queryProductDetailsAsync(params, (result, details) -> {
            List<ProductDetails> list = details.getProductDetailsList();
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || list.isEmpty()) {
                call.reject("Product " + productId + " not found: " + result.getDebugMessage());
                return;
            }
            then.run(list.get(0));
        });
    }

    private interface ProductCallback {
        void run(ProductDetails details);
    }

    @PluginMethod
    public void getProduct(PluginCall call) {
        String productId = call.getString("productId");
        if (productId == null) {
            call.reject("productId is required");
            return;
        }
        connected(call, () -> withProduct(call, productId, details -> {
            JSObject out = new JSObject();
            out.put("productId", productId);
            out.put("title", details.getName());
            ProductDetails.OneTimePurchaseOfferDetails offer = details.getOneTimePurchaseOfferDetails();
            out.put("price", offer != null ? offer.getFormattedPrice() : null);
            call.resolve(out);
        }));
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        String productId = call.getString("productId");
        if (productId == null) {
            call.reject("productId is required");
            return;
        }
        if (pendingPurchase != null) {
            call.reject("A purchase is already in progress");
            return;
        }
        connected(call, () -> withProduct(call, productId, details -> {
            BillingFlowParams flow = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(
                    BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details).build()))
                .build();
            pendingPurchase = call;
            pendingProduct = productId;
            call.setKeepAlive(true);
            getActivity().runOnUiThread(() -> {
                BillingResult r = client.launchBillingFlow(getActivity(), flow);
                if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    finishPurchase(false, r.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED);
                }
            });
        }));
    }

    @Override
    public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null) {
            boolean owned = false;
            for (Purchase p : purchases) {
                if (pendingProduct != null && p.getProducts().contains(pendingProduct) && settle(p)) {
                    owned = true;
                }
            }
            finishPurchase(owned, false);
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            finishPurchase(true, false);
        } else {
            finishPurchase(false, code == BillingClient.BillingResponseCode.USER_CANCELED);
        }
    }

    private void finishPurchase(boolean owned, boolean cancelled) {
        PluginCall call = pendingPurchase;
        pendingPurchase = null;
        pendingProduct = null;
        if (call == null) return;
        JSObject out = new JSObject();
        out.put("owned", owned);
        out.put("cancelled", cancelled);
        call.setKeepAlive(false);
        call.resolve(out);
    }

    /** True for a completed purchase, which is acknowledged if it isn't yet. */
    private boolean settle(Purchase p) {
        if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) return false;
        if (!p.isAcknowledged()) {
            client.acknowledgePurchase(
                AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.getPurchaseToken()).build(),
                ack -> {});
        }
        return true;
    }

    @PluginMethod
    public void restore(PluginCall call) {
        String productId = call.getString("productId");
        if (productId == null) {
            call.reject("productId is required");
            return;
        }
        connected(call, () -> client.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(),
            (result, purchases) -> {
                boolean owned = false;
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (Purchase p : purchases) {
                        if (p.getProducts().contains(productId) && settle(p)) owned = true;
                    }
                }
                JSObject out = new JSObject();
                out.put("owned", owned);
                call.resolve(out);
            }));
    }
}
