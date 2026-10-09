package ua.sasha.pokemonbattle;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.Map;

/**
 * Notifications (app 1.2.0). The game's Sheet sends them through Firebase as data messages (title, text, the
 * channel, the link to open); this shows them, or hands them to the game when it is on screen. The page asks
 * through PkmnAndroid (pushInfo / pushAsk / pushSettings) and hears back through window.pkmnPushToken,
 * window.pkmnPushPerm and window.pkmnPushIn. A build without the Firebase settings simply has no notifications.
 */
final class Push {
    static final String PREFS = "push";
    static final String PERM = "android.permission.POST_NOTIFICATIONS";

    interface TokenCallback { void onToken(String token); }

    private Push() { }

    /** Firebase is set up in this build (the CI passed its settings). */
    static boolean available(Context c) {
        try {
            return !FirebaseApp.getApps(c).isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void saveToken(Context c, String token) {
        if (token != null && token.length() > 0) prefs(c).edit().putString("token", token).apply();
    }

    static String token(Context c) {
        return prefs(c).getString("token", "");
    }

    static void fetchToken(final Context c, final TokenCallback cb) {
        if (!available(c)) return;
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    saveToken(c, task.getResult());
                    if (cb != null) cb.onToken(task.getResult());
                }
            });
        } catch (Throwable ignored) {
            // no notifications on this phone then
        }
    }

    static boolean enabled(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm != null && nm.areNotificationsEnabled();
    }

    /** "granted", "ask" (not asked yet, or may ask again) or "denied" (only the phone's settings can change it). */
    static String permission(Activity a) {
        if (Build.VERSION.SDK_INT >= 33) {
            if (a.checkSelfPermission(PERM) == PackageManager.PERMISSION_GRANTED) return enabled(a) ? "granted" : "denied";
            boolean asked = prefs(a).getBoolean("asked", false);
            return asked && !a.shouldShowRequestPermissionRationale(PERM) ? "denied" : "ask";
        }
        return enabled(a) ? "granted" : "denied";
    }

    static void markAsked(Context c) {
        prefs(c).edit().putBoolean("asked", true).apply();
    }

    static String info(Activity a) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", available(a));
            o.put("token", token(a));
            o.put("perm", permission(a));
            o.put("enabled", enabled(a));
        } catch (Exception ignored) {
            // an empty answer means "no notifications"
        }
        return o.toString();
    }

    /** The channels the phone's settings list (Android 8+), in Ukrainian like the game. */
    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        String[][] list = {
            {"tour", c.getString(R.string.ch_tour), c.getString(R.string.ch_tour_d), "high"},
            {"live", c.getString(R.string.ch_live), c.getString(R.string.ch_live_d), "high"},
            {"challenge", c.getString(R.string.ch_challenge), c.getString(R.string.ch_challenge_d), "high"},
            {"replay", c.getString(R.string.ch_replay), c.getString(R.string.ch_replay_d), "default"},
            {"remind", c.getString(R.string.ch_remind), c.getString(R.string.ch_remind_d), "default"},
            {"week", c.getString(R.string.ch_week), c.getString(R.string.ch_week_d), "low"},
        };
        for (String[] ch : list) {
            int imp = "high".equals(ch[3]) ? NotificationManager.IMPORTANCE_HIGH
                    : "low".equals(ch[3]) ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_DEFAULT;
            NotificationChannel n = new NotificationChannel(ch[0], ch[1], imp);
            n.setDescription(ch[2]);
            nm.createNotificationChannel(n);
        }
    }

    static String channelOf(String ch) {
        if ("tour".equals(ch) || "live".equals(ch) || "challenge".equals(ch) || "replay".equals(ch) || "week".equals(ch)) return ch;
        return "remind";
    }

    static String json(Map<String, String> d) {
        return new JSONObject(d).toString();
    }

    /** Shows one in the phone's tray; tapping it opens the game at its link. */
    @SuppressWarnings("deprecation")
    static void show(Context c, Map<String, String> d) {
        String title = d.get("title");
        if (title == null || title.length() == 0) return;
        String body = d.get("body") == null ? "" : d.get("body");
        String url = d.get("url") == null ? "" : d.get("url");
        String id = d.get("id") == null ? title : d.get("id");
        String ch = channelOf(d.get("ch"));
        channels(c);
        int nid = id.hashCode();

        Intent open = new Intent(c, MainActivity.class);
        open.setAction(MainActivity.ACTION_OPEN + "." + nid);
        open.putExtra(MainActivity.EXTRA_LINK, url);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, nid, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, ch) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setColor(0xFF7B5AEA)
                .setAutoCancel(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT < 26) {
            b.setDefaults(Notification.DEFAULT_ALL);
            b.setPriority("tour".equals(ch) || "live".equals(ch) || "challenge".equals(ch) ? Notification.PRIORITY_HIGH : Notification.PRIORITY_DEFAULT);
        }
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try {
                nm.notify(nid, b.build());
            } catch (SecurityException ignored) {
                // no permission on Android 13+: nothing to show
            }
        }
    }
}
