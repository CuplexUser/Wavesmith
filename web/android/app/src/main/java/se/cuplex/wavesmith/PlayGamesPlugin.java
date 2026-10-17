package se.cuplex.wavesmith;

import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.games.LeaderboardsClient;
import com.google.android.gms.games.PlayGames;
import com.google.android.gms.games.PlayGamesSdk;
import com.google.android.gms.games.SnapshotsClient;
import com.google.android.gms.games.snapshot.Snapshot;
import com.google.android.gms.games.snapshot.SnapshotMetadataChange;
import java.nio.charset.StandardCharsets;

/**
 * Play Games Services v2: automatic sign-in, achievements, leaderboards, and a cloud save
 * holding the progress JSON.
 *
 * Stays inert until a real Games project ID is in app_id in res/values/game-ids.xml, so
 * builds without Play Games set up still run. That file is the Play Console's "Get resources"
 * export; achievements and leaderboards arrive by their name there (without the
 * "achievement_" or "leaderboard_" prefix), and one missing from it is skipped.
 */
@CapacitorPlugin(name = "PlayGames")
public class PlayGamesPlugin extends Plugin {
    private static final String SAVE_NAME = "progress";
    private boolean enabled;

    @Override
    public void load() {
        String id = getContext().getString(R.string.app_id);
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

    /**
     * The Play ID for a name such as "first_ripple" from res/values/game-ids.xml
     * ("achievement_first_ripple"), or null when the file doesn't have it.
     */
    private String playId(String prefix, String name) {
        int res = getContext().getResources()
            .getIdentifier(prefix + name, "string", getContext().getPackageName());
        if (res == 0) return null;
        String id = getContext().getString(res);
        return id.isEmpty() ? null : id;
    }

    /** Unlocks the achievement for {@code name}; resolves without doing anything when it has no ID. */
    @PluginMethod
    public void unlock(PluginCall call) {
        if (!ready(call)) return;
        String name = call.getString("name");
        if (name == null) {
            call.reject("name is required");
            return;
        }
        String id = playId("achievement_", name);
        if (id != null) PlayGames.getAchievementsClient(getActivity()).unlock(id);
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

    /** Submits {@code score} to the leaderboard for {@code name}. Play keeps each player's best. */
    @PluginMethod
    public void submitScore(PluginCall call) {
        if (!ready(call)) return;
        String name = call.getString("name");
        // getInt, not getLong: Capacitor hands small JS numbers over as Integer.
        Integer score = call.getInt("score");
        if (name == null || score == null) {
            call.reject("name and score are required");
            return;
        }
        String id = playId("leaderboard_", name);
        if (id != null) PlayGames.getLeaderboardsClient(getActivity()).submitScore(id, score);
        call.resolve();
    }

    /** Shows the leaderboard for {@code name}, or the list of all leaderboards without one. */
    @PluginMethod
    public void showLeaderboard(PluginCall call) {
        if (!ready(call)) return;
        String name = call.getString("name");
        String id = name != null ? playId("leaderboard_", name) : null;
        if (name != null && id == null) {
            call.reject("No leaderboard ID for " + name, "NOT_CONFIGURED");
            return;
        }
        LeaderboardsClient leaderboards = PlayGames.getLeaderboardsClient(getActivity());
        (id != null ? leaderboards.getLeaderboardIntent(id) : leaderboards.getAllLeaderboardsIntent())
            .addOnSuccessListener(intent -> startActivityForResult(call, intent, "leaderboardClosed"))
            .addOnFailureListener(e -> call.reject(e.getMessage()));
    }

    @ActivityCallback
    private void leaderboardClosed(PluginCall call, ActivityResult result) {
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
