# Task: terreno low poly "rotto" attorno al percorso Peak Prompt (three.js)

## Contesto (dati già verificati, non rifarne l'analisi)
- Progetto statico in questa cartella. NON modificare nulla in `assets/foto/`, `assets/audio/`, `assets/gpx-metadata/`, `assets/dem/`. Non modificare `index.html`: lavora su una pagina nuova `terrain.html`.
- `timeline-data.json` (generato da `build_timeline.py`): `track` (~200 punti Wikiloc sottocampionati, con lat/lon/ele/time), `media` (201 foto + 10 video con lat/lon/ele/time agganciati alla traccia per orario; campi `thumb`, `md`, `src` = versioni web in `assets/web/`), `audio`.
- Traccia principale = Wikiloc: `assets/gpx-metadata/Pian Falzarego - Forcella Lagazuoi - Baracca ufficiali austriaci - Rifugio Lagazuoi.gpx` (644 punti). Bounding box: lat 46.51994–46.53045, lon 12.00864–12.01861 (≈1170 m N-S × 764 m E-W).
- Modello altimetrico: `assets/dem/Copernicus_DSM_COG_10_N46_00_E012_00_DEM.tif` (GeoTIFF float32, EPSG:4326, passo 1" ≈ 30.9 m N-S × 21.3 m E-W). Il tile E011 nella stessa cartella NON serve (l'area è tutta in E012).
- ATTENZIONE quote: le quote GPS di Wikiloc stanno in mediana +31 m SOPRA il DEM (Strava solo +3 m). Per posizionare in verticale traccia e foto usa SEMPRE la quota del DEM campionata in lat/lon; conserva la quota GPS solo come dato da mostrare.

## Obiettivo
Una scena 3D desktop (three.js) con un terreno low poly a facce piatte, frammentato ("rotto"), limitato a un CORRIDOIO largo 200 m centrato sulla traccia (100 m per lato; parametro `CORRIDOR_HALF_WIDTH_M = 100`). Sopra: la traccia e le foto come cornici sospese col nome file (estetica "camera frustum" da fotogrammetria).

## Architettura (due passi separati)

### Passo 1 — preprocess Python: `scripts/build_terrain.py`
Dipendenze: numpy, scipy, rasterio (aggiungi `requirements.txt`). Output in `assets/terrain/`.
1. Sistema di coordinate locale in metri: origine = primo punto della traccia Wikiloc. Proiezione equirettangolare locale con R = 6371000 m e angoli in radianti: `x = R*(lon-lon0)*cos(lat0)` (est), `z = -R*(lat-lat0)` (nord → -z, convenzione three.js); a questa scala (~1 km) l'errore è trascurabile, `y = quota - quota_DEM_origine`. Scrivi l'origine e le costanti nel JSON di output.
2. Ritaglia il DEM sulla bbox della traccia + 150 m di margine; campionamento bilineare.
3. Punti per la triangolazione: griglia a passo `GRID_STEP_M = 12` con jitter casuale (±40% del passo, seed fisso `SEED = 7`), tenendo solo i punti entro `CORRIDOR_HALF_WIDTH_M` dalla polilinea della traccia (distanza punto-segmento in metri) + i punti della traccia stessa. Delaunay 2D (scipy.spatial.Delaunay) su x/z, poi elimina i triangoli con centroide fuori corridoio o con lato > 3×passo (bordi frastagliati: va bene, è voluto).
4. Per ogni triangolo calcola attributi per lo shader:
   - `dist`: distanza del centroide dalla traccia (m)
   - `t`: avanzamento lungo la traccia 0–1 del punto di traccia più vicino
   - `photoDensity`: n. foto entro 40 m dal centroide (posizioni foto da `timeline-data.json`), normalizzata 0–1
   - `gap`: 1 se il punto di traccia più vicino cade tra 15:39 e 16:46 ora locale (13:39–14:46 UTC, buco dei dati Strava), altrimenti 0
   - `seed`: random 0–1
5. Output `assets/terrain/terrain.json`: `{origin, params, positions (Float32 flat, non indicizzato: 3 vertici per triangolo), triAttr: {dist, t, photoDensity, gap, seed}, track: [[x,y,z],...] (traccia Wikiloc completa, y = DEM + 1.5 m), media: [{id, kind, thumb, x, y_ground, z, heading_deg, timeLocal, ele_gps}]}`. `heading_deg` = direzione di marcia della traccia in quel punto (stima: le foto NON hanno bussola).
6. Salva anche `assets/terrain/preview.png` (matplotlib, vista dall'alto: triangoli colorati per quota + traccia) e stampa: n. triangoli, n. vertici, peso del JSON, range quote. Target: 1.500–6.000 triangoli, JSON < 1 MB.
**Fermati qui e mostrami preview e statistiche prima del passo 2.**

### Passo 2 — `terrain.html` + `js/terrain.js`
- three.js da CDN con import map, versione fissata (es. `three@0.169.0` da cdn.jsdelivr.net), niente bundler. Avvio: `python3 -m http.server` (serve fetch del JSON).
- BufferGeometry non indicizzata da `positions`, normali per faccia (`computeVertexNormals` dopo `toNonIndexed` dà facce piatte) o `flatShading: true`.
- Materiale: MeshStandardMaterial grigio caldo + luce direzionale radente; sfondo chiaro neutro; niente texture satellitari.
- "Rotto" via `onBeforeCompile` (o ShaderMaterial): attributi per-vertice copiati dal triangolo (`aCentroid`, `aDist`, `aPhoto`, `aGap`, `aSeed`). Per ogni triangolo: traslazione lungo la normale di faccia + piccola rotazione attorno al centroide + scala verso il centroide. Intensità = f(parametri):
  - `breakByDistance`: più rotto verso i bordi del corridoio
  - `breakByPhotoAbsence`: compatto dove ci sono foto, sgretolato dove non ce ne sono
  - `breakByGap`: il tratto del buco Strava si disgrega
  - `dropRatio`: % di triangoli eliminati (scala a 0) scelti con `aSeed`
  - `verticalExaggeration` (default 1.0)
  Esponi tutto con lil-gui. Default: rottura moderata e leggibile.
- Traccia: Line2 (o tube sottile) dai punti `track`.
- Foto: per ogni elemento `media` un piano con texture `thumb` (lazy: carica le texture solo quando la camera è vicina, max 201 texture leggere), sospeso a `y_ground + 25 m`, ruotato secondo `heading_deg`, bordo sottile, etichetta col nome file (CSS2DRenderer), linea verticale sottile fino al terreno. Video: stessa cosa con il poster e un segno distintivo.
- Camera: OrbitControls con target sul centro del corridoio; vista iniziale obliqua da sud-est.
- Crediti visibili in basso: attribuzione Copernicus DEM come richiesto dalla licenza (`INFO/eula_F.pdf` del dataset) — riporta il testo esatto, non inventarlo.

## Criteri di accettazione
- La traccia non passa mai sotto il terreno (con rottura a zero).
- Il passo 1 è riproducibile (seed fisso) e rigira in < 30 s.
- La pagina regge 60 fps su un MacBook; nessun file sorgente originale toccato.
- Commenti brevi nel codice; costanti di progetto raccolte in cima ai file.
