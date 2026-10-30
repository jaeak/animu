# Graph Report - Animu  (2026-10-27)

## Corpus Check
- Corpus is ~12,739 words - fits in a single context window. You may not need a graph.

## Summary
- 181 nodes · 392 edges · 12 communities (10 shown, 2 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- AnimeThemes Matching
- Spotify Auth & Playback
- Local Server & Downloads
- Video Backdrop Loading
- Kanji Romaji Readings
- App Shell UI
- Package Config
- Timer & Dialogs
- PWA Manifest
- Brand Icons

## God Nodes (most connected - your core abstractions)
1. `findOpening()` - 19 edges
2. `updatePlayback()` - 16 edges
3. `matchTrack()` - 13 edges
4. `spotifyFetch()` - 12 edges
5. `normalise()` - 10 edges
6. `animeThemesFetch()` - 9 edges
7. `findOpeningByArtist()` - 9 edges
8. `pollPlayback()` - 9 edges
9. `notify()` - 8 edges
10. `markFirstVisualReady()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Animu Cat Favicon (SVG)` --semantically_similar_to--> `Animu Cat App Icon`  [INFERRED] [semantically similar]
  favicon.svg → icons/icon-512.png
- `Animu Cat App Icon` --implements--> `Animu Kawaii Cat Brand Identity`  [INFERRED]
  icons/icon-512.png → favicon.svg
- `Animu app shell (index.html)` --implements--> `Animu`  [INFERRED]
  index.html → README.md
- `Opening video backdrop element` --shares_data_with--> `Local video cache (video-cache/, 3 GB LRU)`  [INFERRED]
  index.html → README.md
- `Spotify settings dialog` --implements--> `Spotify Authorization Code with PKCE`  [INFERRED]
  index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Animu Spotify-to-opening backdrop pipeline** — readme_spotify_pkce_auth, readme_song_matching, readme_animethemes_api, readme_video_cache, index_opening_video [INFERRED 0.85]

## Communities (12 total, 2 thin omitted)

### Community 0 - "AnimeThemes Matching"
Cohesion: 0.10
Nodes (42): alternativeTitles(), animeSearchCandidates(), animeThemeArtistRequest(), animeThemeArtistSearch(), animeThemeDetailsRequest(), animeThemeRequest(), animeThemesArtistNames(), animeThemesFetch() (+34 more)

### Community 1 - "Spotify Auth & Playback"
Cohesion: 0.16
Nodes (26): burstPoll(), disconnectSpotify(), formatTime(), getToken(), handleCallback(), hideCover(), initialise(), markFirstVisualReady() (+18 more)

### Community 2 - "Local Server & Downloads"
Cohesion: 0.16
Nodes (22): downloads, failDownload(), mimeTypes, nextQueuedIndex(), parseRange(), port, pumpUpstream(), respond() (+14 more)

### Community 3 - "Video Backdrop Loading"
Cohesion: 0.18
Nodes (19): cancelPendingVideo(), hideVideo(), isVisualKnown(), largeCoverUrl(), layerFor(), loadVideo(), matchTrack(), prefetchUpcoming() (+11 more)

### Community 4 - "Kanji Romaji Readings"
Cohesion: 0.25
Nodes (10): dictionaryFile, loadReadings(), loadWords(), matchReadings(), normaliseRomaji(), readingForms(), readsAs(), titleUnits() (+2 more)

### Community 5 - "App Shell UI"
Cohesion: 0.19
Nodes (11): app.js (Animu client script), Animu app shell (index.html), Apps dialog: Timer, Background brightness (dim) slider, Opening video backdrop element, Spotify playback controls, Spotify settings dialog, AnimeThemes API (+3 more)

### Community 6 - "Package Config"
Cohesion: 0.21
Nodes (12): dependencies, kuromoji@^0.1.2, wanakana@^5.3.1, name, private, scripts, start, kuromoji (+4 more)

### Community 7 - "Timer & Dialogs"
Cohesion: 0.22
Nodes (11): connectSpotify(), finishTimer(), formatCountdown(), openDialog(), playChime(), randomString(), renderTimer(), sha256() (+3 more)

### Community 8 - "PWA Manifest"
Cohesion: 0.22
Nodes (8): background_color, display, icons, id, name, short_name, start_url, theme_color

### Community 9 - "Brand Icons"
Cohesion: 1.00
Nodes (3): Animu Kawaii Cat Brand Identity, Animu Cat Favicon (SVG), Animu Cat App Icon

## Knowledge Gaps
- **4 isolated node(s):** `app.js (Animu client script)`, `Apps dialog: Timer`, `Background brightness (dim) slider`, `Spotify playback controls`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 42 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `wanakana` connect `Package Config` to `Kanji Romaji Readings`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **What connects `app.js (Animu client script)`, `Apps dialog: Timer`, `Background brightness (dim) slider` to the rest of the system?**
  _4 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `AnimeThemes Matching` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Why does `japaneseTokenizer()` connect `Package Config` to `Local Server & Downloads`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._