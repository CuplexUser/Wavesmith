package se.cuplex.wavesmith;

import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.games.PlayGames;
import com.google.android.gms.games.PlayGamesSdk;
import com.google.android.gms.games.SnapshotsClient;
import com.google.android.gms.games.snapshot.Snapshot;
import com.google.android.gms.games.snapshot.SnapshotMetadataChange;
import java.nio.charset.StandardCharsets;

/**
 * Play Games Services v2: automatic sign-in, achievements, and a cloud save holding the
 * progress JSON.
 *
 * Stays inert until a real Games project ID replaces the placeholder in
 * res/values/games.xml, so builds without Play Games set up still run.
 */
@CapacitorPlugin(name = "PlayGames")
public class PlayGamesPlugin extends Plugin {
    private static final String SAVE_NAME = "progress";
    private boolean enabled;

    @Override
    public void load() {
        String id = getContext().getString(R.string.game_services_project_id);
        enabled = id != null && !id.isEmpty() && !id.startsWith("REPLACE");
        if (enabled) PlayGamesSdk.initialize(getContext());
    }

    private boolean ready(PluginCall call) {
        if (!enabled) {
            call.reject("Play Games is not configured", "UNAVAILABLE");
            return false;
        }
        return true;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", enabled);
        call.resolve(out);
    }

    /** Resolves {signedIn}. Play Games signs players in automatically at launch when it can. */
    @PluginMethod
    public void status(PluginCall call) {
        if (!ready(call)) return;
        PlayGames.getGamesSignInClient(getActivity()).isAuthenticated().addOnCompleteListener(task -> {
            JSObject out = new JSObject();
            out.put("signedIn", task.isSuccessful() && task.getResult().isAuthenticated());
            call.resolve(out);
        });
    }

    /** Explicit sign-in, from a button, when automatic sign-in didn't happen. */
    @PluginMethod
    public void signIn(PluginCall call) {
        if (!ready(call)) return;
        PlayGames.getGamesSignInClient(getActivity()).signIn().addOnCompleteListener(task -> {
            JSObject out = new JSObject();
            out.put("signedIn", task.isSuccessful() && task.getResult().isAuthenticated());
            call.resolve(out);
        });
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        if (!ready(call)) return;
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        PlayGames.getAchievementsClient(getActivity()).unlock(id);
        call.resolve();
    }

    @PluginMethod
    public void showAchievements(PluginCall call) {
        if (!ready(call)) return;
        PlayGames.getAchievementsClient(getActivity()).getAchievementsIntent()
            .addOnSuccessListener(intent -> startActivityForResult(call, intent, "achievementsClosed"))
            .addOnFailureListener(e -> call.reject(e.getMessage()));
    }

    @ActivityCallback
    private void achievementsClosed(PluginCall call, ActivityResult result) {
        call.resolve();
    }

    /** Writes {@code data} (the progress JSON) to the cloud save. */
    @PluginMethod
    public void save(PluginCall call) {
        if (!ready(call)) return;
        String data = call.getString("data", "");
        SnapshotsClient snapshots = PlayGames.getSnapshotsClient(getActivity());
        snapshots.open(SAVE_NAME, true, SnapshotsClient.RESOLUTION_POLICY_MOST_RECENTLY_MODIFIED)
            .addOnSuccessListener(result -> {
                Snapshot snapshot = result.getData();
                if (snapshot == null) {
                    call.reject("Save conflict");
                    return;
                }
                snapshot.getSnapshotContents().writeBytes(data.getBytes(StandardCharsets.UTF_8));
                SnapshotMetadataChange change = new SnapshotMetadataChange.Builder()
                    .setDescription("Wavesmith progress")
                    .build();
                snapshots.commitAndClose(snapshot, change)
                    .addOnSuccessListener(meta -> call.resolve())
                    .addOnFailureListener(e -> call.reject(e.getMessage()));
            })
            .addOnFailureListener(e -> call.reject(e.getMessage()));
    }

    /** Resolves {data} with the cloud save's JSON, or an empty string when there is none. */
    @PluginMethod
    public void load(PluginCall call) {
        if (!ready(call)) return;
        SnapshotsClient snapshots = PlayGames.getSnapshotsClient(getActivity());
        snapshots.open(SAVE_NAME, true, SnapshotsClient.RESOLUTION_POLICY_MOST_RECENTLY_MODIFIED)
            .addOnSuccessListener(result -> {
                Snapshot snapshot = result.getData();
                JSObject out = new JSObject();
                try {
                    byte[] bytes = snapshot != null ? snapshot.getSnapshotContents().readFully() : new byte[0];
                    out.put("data", new String(bytes, StandardCharsets.UTF_8));
                    if (snapshot != null) snapshots.discardAndClose(snapshot);
                    call.resolve(out);
                } catch (java.io.IOException e) {
                    call.reject(e.getMessage());
                }
            })
            .addOnFailureListener(e -> call.reject(e.getMessage()));
    }
}
