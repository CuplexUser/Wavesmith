package se.cuplex.wavesmith;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(BillingPlugin.class);
        registerPlugin(PlayGamesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
