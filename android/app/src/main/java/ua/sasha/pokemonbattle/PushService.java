package ua.sasha.pokemonbattle;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/** Firebase hands the game's notifications here (data messages), even when the app isn't running. */
public class PushService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        Push.saveToken(this, token);
        MainActivity.sendToken(token);// the page registers it with the Sheet
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        if (d == null || d.isEmpty()) return;
        // the game is on screen: it shows a banner itself (and nothing piles up in the tray)
        if (MainActivity.forward(d)) return;
        Push.show(this, d);
    }
}
