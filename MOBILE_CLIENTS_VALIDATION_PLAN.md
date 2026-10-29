# Validación de los clientes móviles de Automata (Samsung S25 Ultra e iPhone 13)

Fecha: 28 oct 2026 · Rama `feature/p4-android-delivery` · **Esto es un plan. No se tocó ningún teléfono, no se ejecutó `adb`, no se compiló ni se instaló nada, no se cambió ninguna regla de Windows.** Todo lo que sigue sobre el comportamiento de los clientes sale de leer el repositorio (`server/index.mjs`, `public/`, `android/`, `scripts/`); lo que no se ha ejecutado se marca como *hipótesis* o *por comprobar*.

Complementa `ANDROID_DELIVERY_PLAN.md` (hitos A1–A6, que **no se interrumpen**) y entra como pista paralela de «validación de clientes» dentro del plan de entrega final (sección 7). El requisito para el iPhone nativo está aparte: `IOS_NATIVE_REQUIREMENTS.md`.

## 1. Dos cosas que no deben confundirse

| | Cliente Android **de Automata** | App Android **creada por Automata** |
|---|---|---|
| Qué es | La interfaz de Automata (`public/`) dentro de un WebView que se conecta al coordinador de la PC | El resultado de un proyecto del usuario (p. ej. «Gastos del mes») envuelto en un WebView |
| Paquete | `app.automata.workspace` | `apps.local.<nombre>.p<8 hex>` (nunca `app.automata.*`; el constructor lo rechaza) |
| Origen del código | `android/` + `scripts/build-android.ps1` | `server/androidbuild.mjs` (A1) |
| Salida | `dist/Automata-Android.apk` | `<proyecto>/dist/android/<nombre>.apk` + `build-info.json` |
| Firma | `android/build/automata-debug.keystore` (llave de desarrollo de Automata) | Llave por proyecto en `<datos>/android-keys/<id>/` |
| Verificación | Este plan (M1–M5) | `androidverify.mjs` (A2) y el dispositivo en A3 |
| Ya instalado en el Samsung | **Sí** (versión 0.4.0 según la auditoría de A3) | No |

Reglas para que no se mezclen (valen para todo el código de dispositivo que se escriba):
1. Los scripts de dispositivo trabajan con una **lista exacta de paquetes permitidos** por operación: A3/A5 solo pueden instalar/desinstalar el paquete registrado en el `build-info.json` de la app creada; la prueba de los clientes solo puede *leer* `app.automata.workspace` hasta la autorización final. Nada de desinstalar «por patrón».
2. Antes y después de cada operación de A3/A5 se anota, en solo lectura, la huella del cliente (`pm path`, `versionCode`, `lastUpdateTime`, firma) y se comprueba que **no cambió**. Si cambió, se detiene todo.
3. Nombres distintos en pantalla y en informes: «Cliente de Automata» y «App creada». Carpetas distintas (`dist/` de Automata vs `dist/android/` del proyecto).

## 2. Cómo se conectan hoy los clientes (hechos del código)

- El coordinador (`server/index.mjs`) escucha en `127.0.0.1`; con `--lan` (`Start-Automata.ps1 -Lan`) escucha en `0.0.0.0` y **también sirve `public/` por HTTP**. No hay HTTPS.
- Toda la API exige `Authorization: Bearer <token>` (32 bytes aleatorios en `access-token`, permisos 0600). `/api/pairing` entrega el token y las direcciones **solo a la propia PC** (loopback). El teléfono recibe el token escrito por la persona en el diálogo «Conectar PC» (dirección + código).
- Origen: se acepta sin `Origin`, el propio, `https://automata.local` (cliente Android) y, con `--lan`, cualquier origen cuyo host sea una dirección de esta PC y el mismo puerto. **Con `--lan` la comprobación de `Host` se desactiva** (solo se mantiene con loopback). Hay que valorarlo en seguridad (M5).
- La interfaz guarda `{origin, token}` en `localStorage` (`automata.connection`) y el proyecto elegido en `automata.project`. **La selección de proyecto es por cliente**, no del coordinador: «información consistente» significa mismos datos, no necesariamente la misma pantalla.
- Eventos en vivo: `fetch` a `/api/events` leído con `ReadableStream`; si se corta, el cliente reintenta cada 3 s («Reconectando» / «Sin conexión»).
- El cliente Android envuelve `public/` en `https://automata.local/`, con `usesCleartextTraffic=true`, permiso `INTERNET`, **`debuggable=true`** y `MIXED_CONTENT_ALWAYS_ALLOW`. Es un APK de desarrollo hecho para hablar por HTTP con la PC (USB con `adb reverse`, o Wi-Fi). Ver riesgos en M1.
- `scripts/smoke-phone.mjs` ya hace una prueba de punta a punta con un Samsung (instala `dist/Automata-Android.apk`, `adb reverse`, WebView por Playwright `_android`, ciclo demo, ajustes en inglés). **Instala y no desinstala**: no se ejecuta hasta la autorización final.

## 3. Hitos de validación (pista M, en paralelo a A3–A5)

Cada hito cierra con evidencia y un commit local. Nada se declara «soportado» hasta M6.

| # | Hito | Toca teléfono | Requiere autorización |
|---|---|---|---|
| M0 | Auditoría de brechas de la interfaz móvil/PWA (solo lectura del código) → **hecha en este documento** | No | No |
| M1 | Preparación en la PC: compilar el cliente Android a una carpeta temporal, inspeccionarlo con herramientas del SDK y emular la interfaz móvil en Chrome | **No** | No (solo PC; la compilación escribe en `dist/` y `android/build/`, ya ignorados por Git) |
| M2 | Segunda instancia del coordinador en red local (`--lan`, puerto propio, datos propios, modo demo) | No | **Sí**: regla de Firewall de Windows (ver 4) |
| M3 | Samsung: leer el estado actual y, tras la autorización final, validar/instalar el cliente | Lectura (M3a) → instalación (M3b) | M3a: lectura por ADB; **M3b: autorización final** |
| M4 | iPhone: Safari, y luego PWA en pantalla de inicio | Safari: solo navega; PWA: añade un icono | Safari: sí (usar el teléfono); PWA: autorización separada |
| M5 | Los dos a la vez: consistencia, reconexión, aprobaciones, seguridad | Sí | Las de M3/M4 |
| M6 | Informe `MOBILE_CLIENTS_REPORT.md` y decisión de soporte | No | No |

### M1 · Preparación en la PC (sin teléfonos)
1. Compilar el cliente: `scripts/build-android.ps1` con **JDK 21** (`-JavaHome` apuntando al de `~/.gradle/jdks`). *Por comprobar:* nunca se probó con ese JDK; usa `-source 8 -target 8` y `aapt add`. Como `public/` no tiene subcarpetas, **no le afecta** el defecto de los nombres con barra invertida de `aapt2 -A` descubierto en A1; aun así se comprueba.
2. Inspección estática del APK con herramientas del SDK (`apksigner verify`, `aapt2 dump badging/xmltree`) y registro de hash. `androidverify.mjs` no sirve tal cual: está hecho para apps creadas (espera `assets/web/`, sin `INTERNET`, sin depuración). Se haría un **perfil «cliente»** con sus propias expectativas explícitas (paquete `app.automata.workspace`, `INTERNET` aprobado, depuración/HTTP **documentados como desarrollo**), sin relajar las reglas de las apps creadas.
3. Interfaz móvil en Chrome con emulación (ancho 390×844 para iPhone 13; unos 412×915 para el S25 Ultra, **cifras a confirmar**): sin desbordamiento horizontal, pestañas móviles, diálogos, teclado simulado, `safe-area`. Es una señal, no Safari ni WebView.
4. Hipótesis a verificar (ya vistas en el código): textos de formulario de 12–14 px (Safari de iPhone **hace zoom al enfocar** campos con menos de 16 px); solo `padding-bottom` usa `safe-area-inset`; el icono es de 256×256 (Apple pide 180×180 para el icono de pantalla de inicio, se escala sin problema); no hay `manifest`, `apple-touch-icon` ni metadatos de app web.

### M2 · Coordinador de prueba en red local
- Una **segunda instancia** (nunca la Automata abierta del usuario): `node server/index.mjs --lan --demo --port <libre> --data <carpeta propia>`; token propio de prueba.
- Un teléfono solo llega a la PC si el Firewall deja entrar ese puerto desde la red privada. Windows lo pide al primer arranque y eso **crea una regla global**. Propuesta: una única regla de entrada, **solo perfil Privado, solo ese puerto TCP y ese programa**, creada con tu autorización explícita, anotada en el informe y **retirada al terminar**. Sin ella, el iPhone no puede probarse (no tiene `adb reverse`); el Samsung sí, por USB.
- Requisitos de red a confirmar contigo: PC y teléfonos en la **misma Wi-Fi** sin «aislamiento de clientes» (redes de invitados y algunos repetidores lo activan).

### M3 · Samsung S25 Ultra (cliente Android de Automata)
- **M3a (solo lectura, tras tu OK):** `adb devices`, modelo/Android/API, y para `app.automata.workspace`: `versionName/Code`, `lastUpdateTime`, **firma instalada** frente a la del APK recién compilado. Esto responde la pregunta clave: si las firmas coinciden, `install -r` actualiza conservando datos; si no, Android rechaza la actualización y solo se podría desinstalar primero (pierde la conexión guardada del cliente). No se hace ninguna de las dos sin tu autorización.
- **M3b (autorización final):** instalar/actualizar el cliente, conectarlo (USB con `adb reverse` y también por Wi-Fi), ejecutar las comprobaciones de la sección 5 y dejar el teléfono como estaba (el cliente queda instalado solo si lo autorizas así).
- Se respeta A3: el paquete de prueba de una app creada y el cliente se manejan en operaciones separadas, con la regla de huella de la sección 1.

### M4 · iPhone 13
**M4a, Safari (no instala nada):** abrir `http://<IP de la PC>:<puerto>/` en Safari, conectar con dirección y código, recorrer la interfaz.
- *Hipótesis sobre iOS (por comprobar):* funciona por HTTP (no hay contenido mixto porque la interfaz y la API son el mismo origen); el `ReadableStream` de eventos se corta al pasar Safari a segundo plano y la lógica de reintento debe recuperarlo; Safari **borra el almacenamiento de scripts de sitios sin uso tras ~7 días** (se perdería la conexión guardada); el zoom al enfocar campos pequeños (M1.4).
- **No se puede** inspeccionar el WebKit del iPhone desde Windows (el Inspector web de Safari necesita un Mac). Las comprobaciones serán: lo que se ve (capturas que tú tomes o que describas), el registro del coordinador y una lista guiada. Si autorizas descargar el motor WebKit de Playwright (una descarga, **no autorizada hoy**) habría una simulación de iPhone en Windows, que sigue sin ser Safari real.
- Hace falta saber la **versión de iOS** (Ajustes → General → Información), porque cambia lo que Safari permite.

**M4b, PWA en pantalla de inicio (modifica el teléfono: añade un icono):** se evalúa, no se promete.
- Brechas ya vistas: no hay `manifest.webmanifest` (el servidor ya sabe servir ese tipo) ni `apple-touch-icon` ni `apple-mobile-web-app-capable`; sin ello iOS añade un marcador que abre Safari, no una app a pantalla completa.
- Límites por servir **HTTP en red local**: no es un contexto seguro, así que **no hay service worker** (sin modo sin conexión, algo que de todos modos no tendría sentido: la PC debe estar encendida) ni notificaciones web push. Instalar en pantalla de inicio sí es posible con HTTP.
- En iOS, la app añadida a la pantalla de inicio tiene **almacenamiento propio, separado de Safari**: habría que volver a conectar (dirección + código) tras instalarla.
- Cambios de código necesarios, **no hechos** y solo con tu aprobación: manifiesto, icono 180×180, metadatos, ajustes de `safe-area`/tamaño de campos, y una prueba. Son cambios al cliente que también benefician al Samsung, así que se verifican en ambos.
- HTTPS real (certificado de confianza o un túnel privado tipo VPN/Tailscale) desbloquearía más funciones, pero exige instalar certificados o software en el teléfono o la PC; queda como decisión aparte.

### M5 · Los dos dispositivos, un solo coordinador
Cada comprobación se ejecuta con la instancia de prueba y el modo demo (determinista), con los dos teléfonos conectados a la vez y, como tercer observador, un cliente de escritorio automatizado (Chrome) que lee la verdad desde la API.

| Área | Qué se comprueba | Cómo se observa |
|---|---|---|
| Conexión | Código correcto conecta; incorrecto o vacío no; dirección sin protocolo o con ruta se rechaza con mensaje claro; «Conectado a tu PC» visible | Samsung: WebView + Playwright (`_android`, como `smoke-phone.mjs`); iPhone: lista guiada + capturas |
| Reconexión | (1) Parar y volver a arrancar el coordinador de prueba: ambos pasan por «Reconectando» y vuelven solos, sin duplicar eventos; (2) teléfono bloqueado/segundo plano 60 s y vuelta; (3) cambio de Wi-Fi o modo avión **solo si tú lo haces y lo autorizas** | Eventos del coordinador, estado visible, contador de reintentos |
| Proyectos | Ambos listan los mismos proyectos; crear uno en un cliente aparece en el otro; la selección de cada cliente es independiente | API frente a pantalla |
| Progreso | Ronda, tareas y estado del trabajo coinciden en ambos y en el observador, con la misma secuencia de eventos y sin saltos ni repeticiones; retraso máximo medido | Secuencia de ids de eventos |
| Aprobaciones | Aprobar desde uno se refleja en el otro; aprobar dos veces o desde un cliente desactualizado es rechazado con mensaje claro; solo se aprueba lo pendiente; ninguna aprobación llega sin acción humana | Flujo demo de propuestas y de petición de *merge* |
| Seguridad | Sin token → 401; token ajeno → 401; `Origin` no permitido → 403; `/api/pairing` desde el teléfono → 403; el token no aparece en la URL, en los registros ni en capturas; «olvidar conexión» borra `localStorage`; con `--lan` apagado, la LAN no ve nada; solo el puerto de la regla de Firewall está abierto; a qué interfaces se enlaza (`0.0.0.0` incluye adaptadores virtuales y VPN) | Pruebas con `fetch` desde la PC y desde un teléfono, escaneo **solo de la propia PC** |

Riesgos de seguridad ya identificados, a documentar con decisión del usuario (no se resuelven solos):
- **Token en HTTP sin cifrar** por la red local: quien pueda escuchar la Wi-Fi puede leerlo. Mitigar: red privada de confianza, modo `--lan` solo mientras se usa, rotación del token tras las pruebas, y HTTPS como mejora opcional.
- Con `--lan` no se valida `Host` (posibilidad de *DNS rebinding*; el token y el control de `Origin` lo limitan, pero hay que probarlo).
- El cliente Android actual es **depurable**, admite HTTP y mezcla contenido: aceptable para desarrollo, no como entrega final. Para entregar al usuario habría que decidir una variante sin depuración (el HTTP por LAN lo seguiría necesitando) o limitar el HTTP a direcciones privadas con una configuración de red.
- Una app creada por Automata **nunca** debe poder usar el token ni hablar con el coordinador: están en paquetes y orígenes distintos y el envoltorio de las apps creadas bloquea todo origen ajeno. Se confirma en M5 con una app de muestra instalada junto al cliente (cuando A3 la instale).

### M6 · Criterios para declarar soporte
- Samsung: cliente instalado/actualizado con autorización, todas las comprobaciones de M5 correctas por USB y por Wi-Fi, cliente restaurado o dejado como se acordó.
- iPhone: Safari correcto en las comprobaciones que se puedan observar; PWA solo si el manifiesto y el comportamiento se verificaron en el teléfono real y se documentan sus límites.
- Ambos: consistencia comprobada con la misma secuencia de eventos; seguridad sin hallazgos sin resolver o aceptados por escrito.
- Un fallo no verificado en un dispositivo **no** se cubre con una prueba en otro ni con emulación.

## 4. Autorizaciones que se pedirán (escalera)

| Nivel | Acción | Cuándo |
|---|---|---|
| 0 | Solo PC: compilar a carpeta temporal, inspeccionar, emular en Chrome, pruebas | M1 |
| 1 | Regla de Firewall acotada (Privado, un puerto, un programa) y su retirada | M2 |
| 2 | Lectura por ADB del Samsung (`devices`, propiedades, paquetes, firma) | M3a |
| 3 | Usar Safari del iPhone en una dirección local | M4a |
| 4 | Paquete de prueba de una app creada: instalar/desinstalar solo ese | A3/A5 (ya previsto) |
| 5 | **Instalar o actualizar el cliente de Automata en el Samsung** (autorización final) | M3b |
| 6 | Añadir la PWA a la pantalla de inicio del iPhone | M4b |
| 7 | Cambios de código del cliente (manifiesto, metadatos, tamaños) | Antes de M4b |

Hasta recibir cada nivel, ese paso **no se ejecuta**. Nada de esto se hace sin push ni merge.

## 5. Cómo encaja en el plan de entrega final

Se añade a `ANDROID_DELIVERY_PLAN.md` una pista «Validación de clientes (M)». No retrasa A3–A5; comparte con A3 solo la ventana de dispositivo y la autorización del Samsung. Orden sugerido: M0–M1 ahora (sin teléfonos) → A3 → M2–M3a → A4 → A5 → M3b/M4/M5 con la autorización final → M6 junto al informe final de entrega.

## 6. Decisiones que necesito

1. ¿Autorizas M1 (compilar el cliente Android a una carpeta temporal y emular la interfaz móvil en Chrome)? No toca teléfonos.
2. Regla de Firewall acotada para M2: ¿sí/no, y ¿quién la crea (yo, con tu confirmación visible, o tú)?
3. ¿La PC y los dos teléfonos comparten una Wi-Fi doméstica de confianza sin aislamiento? ¿Qué versión de iOS tiene el iPhone 13?
4. ¿Tienes acceso a un Mac (propio o prestado)? Cambia lo que se puede inspeccionar del iPhone y abre la ruta nativa (ver `IOS_NATIVE_REQUIREMENTS.md`).
5. ¿Quieres que se prepare la PWA (cambios del nivel 7) o solo evaluarla en Safari?
