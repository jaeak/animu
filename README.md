# Animu

Animu provides a small aesthetic backdrop for music. When an anime song is played on Spotify, it finds the matching opening and loops the animation full-screen in the background, with an option to dim the screen depending on the user's mood. It is static web app that connects to Spotify, controls the account's current playback, and looks up a matching looping anime opening from the AnimeThemes catalog.

## Run locally

From this folder, start animu's local server:

```powershell
node server.js
```

Open `http://127.0.0.1:8000/` in your browser. Spotify does not allow `localhost` as a redirect URI; use the explicit loopback IP address. Spotify's OAuth redirect flow does not work from a `file://` URL.

## Connect Spotify

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. In animu's settings, copy the displayed redirect URI and add it to the Spotify app's **Redirect URIs**.
3. Paste the Spotify app's client ID into animu, then choose **Save & connect** and approve access.
4. Start listening on Spotify. animu follows the active track and device; playback controls act on that Spotify session.

Animu uses Spotify's Authorization Code with PKCE flow and does not need a client secret. The client ID is stored in local storage; the short-lived sign-in refresh token is kept in session storage. Spotify account access and playback control are subject to Spotify's current API and account requirements.

## Anime visuals

The app searches the public [AnimeThemes API](https://animethemes.moe/) by song title and artist, then loops the matched opening as a sharp, full-screen background. AnimeThemes' video host only allows a few requests in quick succession, so the local server downloads each video once into `video-cache/` (kept under 3 GB, least recently watched removed first) and streams it to the browser while it downloads. If no song match is found, the app also tries track and album information to identify an anime and show its first opening; if that fails too, the song's cover art is shown as the background. The dim slider adjusts a dark overlay without blurring or replacing the video with Spotify album art. Song-title matching is normalized to tolerate common version labels and formatting differences; matching artist credits are considered when available. Some songs will not have a catalog match, and catalog availability can vary.

## License & credits

Code is released under the [MIT License](LICENSE).

Anime openings are streamed from [AnimeThemes](https://animethemes.moe/) and belong to their respective studios and rights holders. Music playback is provided by Spotify. animu is a personal fan project and isn't affiliated with Spotify, AnimeThemes, or any anime studio.
