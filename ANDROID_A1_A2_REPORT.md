# Android A1 + A2: constructor y verificador de APK (WebView)

Fecha: 28 oct 2026 · Rama `feature/p4-android-delivery` (creada desde `feature/p3-idea-to-project` con P4 Web completo y verificado) · **Sin push, sin merge.**

**Estado honesto:** Automata ya puede *construir* y *verificar estáticamente* el APK de una web ya entregada. **No hay soporte Android declarado** (`VERIFIED_TARGETS` sigue siendo `["web"]`), **ningún APK se instaló en ningún dispositivo** y no se ejecutó una sola instrucción de `adb` ni se arrancó un emulador. Nadie sabe todavía si el código Java del envoltorio, ni la app web dentro de él, funcionan en Android: eso es A3.

## 1. Lo que se hizo, en una línea

| Hito | Resultado |
|---|---|
| Git | P4 Web estaba completamente commiteado (solo `package-lock.json`, sin seguimiento desde antes, queda aparte). `npm test` 285/285 antes de empezar. Rama creada; sin push ni merge. |
| A1 | `server/androidbuild.mjs` construye un APK firmado desde un proyecto autorizado, sin Gradle, sin descargas. |
| A2 | `server/androidverify.mjs` verifica el APK por su cuenta (20 comprobaciones) y **nunca** lo declara funcional. |
| Pruebas | 30 pruebas nuevas; `npm test` **315/315** (3 corridas seguidas limpias al final). |
| APK real | Generado de la app `gastos-del-mes-6` (la que superó P4 Web) y verificado: 20/20, 0 errores. |

## 2. Código implementado

| Archivo | Líneas | Qué es |
|---|---|---|
| `server/androidbuild.mjs` | 686 | Constructor: validaciones, plantillas, localizador de JDK/SDK, llave de firma, etapas de compilación, `build-info.json`. |
| `server/apkzip.mjs` | 203 | Lector ZIP estricto (y un escritor mínimo `addToZip`), sin dependencias. |
| `server/androidverify.mjs` | 294 | Verificador independiente. |
| `scripts/android-build.mjs` | 29 | Línea de comandos: construye y verifica. No instala nada. |
| `test/android-build.test.mjs`, `test/android-verify.test.mjs`, `test/androidfixture.mjs`, `test/zipmaker.mjs` | 679 | Pruebas y ayudas. |

Uso: `node scripts/android-build.mjs --project <carpeta> --data <carpeta de datos> --name "Mi app" [--permission P] [--no-verify]`.

### A1: cómo construye

1. **Valida antes de tocar nada:** carpeta del proyecto con la misma regla de seguridad que ya usa Automata (`directoryProblem`), carpeta de datos fuera del proyecto, nombre de paquete, nombre visible, `versionCode`/`versionName`, `minSdk`/`targetSdk`, permisos, `webRoot` y `outDir` dentro del proyecto, y que ese identificador no lo use ya otro proyecto.
2. **Identidad propia, nunca la de Automata.** Paquete por defecto `apps.local.<nombre>.p<8 hex>` (derivado del proyecto). Se rechazan `app.automata.*`, `android.*`, `com.android.*`, `com.google.*`, palabras reservadas de Java y nombres mal formados.
3. **Sin Java arbitrario.** Automata genera el manifiesto, `strings.xml`, el ícono (vectorial, color derivado del proyecto) y **una sola `MainActivity`** desde plantillas. El manifiesto generado se revisa (solo elementos conocidos, permisos = aprobados).
4. **La web:** se empaqueta solo lo que `collectWebAssets` acepta: archivos normales, tipos web conocidos, nombres seguros (`[A-Za-z0-9][A-Za-z0-9._-]*`), ≤ 8 MB cada uno, ≤ 40 MB y ≤ 500 archivos en total, sin enlaces simbólicos, sin ocultos, sin `node_modules`/`test`/`dist`/`android`, sin `package.json`/`ui-check.json`/guías, sin archivos sensibles (`.env`, llaves) y **rechazando** cualquier archivo cuyo contenido tenga forma de credencial (se usan los mismos patrones de `redact.mjs`). Lo omitido queda listado con su razón en `build-info.json`.
5. **Etapas:** `aapt2 compile` → `aapt2 link` → `javac --release 8` → `d8` → ensamblado del APK (`addToZip`) → `zipalign` (+ comprobación) → `apksigner sign` → `apksigner verify`. Cada etapa se ejecuta sin shell, con tiempo límite, con entorno mínimo (sin tokens ni `JAVA_TOOL_OPTIONS`) y registrada en el proceso de Automata para limpiar si algo se cuelga. Un fallo devuelve `{ok:false, stage, code, error, detail, logPath}` con la salida de la herramienta; nunca lanza excepción por un fallo esperado.
6. **Firma:** una llave de desarrollo **por proyecto** (PKCS12, RSA 2048) en `<datos>/android-keys/<id>/`, fuera del proyecto. Su contraseña es aleatoria, vive en un archivo y se entrega a `keytool`/`apksigner` **como archivo** (`:file`, `file:`), nunca en una línea de comandos ni en el registro. Se reutiliza en cada construcción del mismo proyecto (una actualización solo instala sobre el mismo paquete si la firma es la misma) y se comprueba que el certificado no cambie.
7. **Salida:** `<proyecto>/dist/android/<nombre>.apk` y `build-info.json` (SHA-256 del APK y del DEX, de cada asset, versión de JDK/`javac`/`aapt2`/`d8`/`apksigner`/Build-Tools, `minSdk`/`targetSdk`, permisos, certificado, lo omitido). Sin rutas del usuario. Los intermedios y el registro van a `<datos>/android-builds/<id>/` (se conservan los últimos 5).

### El envoltorio (la única Activity)

- Sirve los archivos de `assets/web` en `https://appassets.local/` mediante `shouldInterceptRequest`: GET, mismo host, ruta que cumple `[A-Za-z0-9._/-]+` sin `..` ni `//`. **Todo lo demás se responde 403/404 vacío** (navegación y subrecursos); `shouldOverrideUrlLoading` bloquea cualquier URL ajena sin abrirla.
- Sin `addJavascriptInterface`, sin depuración web, sin `file://`: `setAllowFileAccess(false)`, `setAllowContentAccess(false)`, `setAllowFileAccessFromFileURLs(false)`, `setAllowUniversalAccessFromFileURLs(false)`, `MIXED_CONTENT_NEVER_ALLOW`, sin ventanas múltiples, sin geolocalización.
- Respuestas con `Content-Security-Policy` (`default-src 'self'`; scripts y estilos `'self'` e inline; `connect-src 'self'`; `object-src 'none'`; `frame-ancestors 'none'`) y `X-Content-Type-Options: nosniff`.
- Implementa `alert`/`confirm` con diálogos nativos, registra la consola de la página en `logcat` (`AutomataWeb`) y cierra la app si el proceso del WebView muere.
- Manifiesto: `debuggable=false`, `usesCleartextTraffic=false`, `allowBackup=false`, **sin permisos por defecto** (solo `INTERNET`, `ACCESS_NETWORK_STATE` y `VIBRATE` pueden aprobarse; cualquier otro se rechaza), una sola actividad exportada (la inicial), `minSdk 26`, `targetSdk 36`.
- Aislamiento: paquete propio, llave propia y datos privados por proyecto (cada app tiene su sandbox de Android; `allowBackup=false`).

### Hallazgo de la verificación independiente (importante)

La primera versión usaba `aapt2 link -A` para meter los assets. **Compiló, `apksigner` la firmó y la dio por válida, pero `aapt2` en Windows escribió los nombres como `assets/web\app.js` (con barra invertida)**: Android nunca habría encontrado esos archivos y la app habría abierto una página en blanco. Lo detectó el lector ZIP estricto del verificador (rechaza `\` en los nombres), no `apksigner`. Corrección: `aapt2` ya no recibe assets; el DEX y la web se añaden con `addToZip` (nombres con `/`, fechas fijas, entradas existentes copiadas sin tocar). Hay pruebas de ambas piezas. Este caso es la razón por la que «compila y está firmado» no se acepta como prueba.

### A2: qué verifica `androidverify.mjs`

Las 10 comprobaciones pedidas, más algunas derivadas (cada una devuelve `id`, título, nivel y detalle; `ok` solo si no hay errores):

| Pedido | Comprobación (id) |
|---|---|
| 1. APK realmente generado | `file` (existe, archivo normal, no enlace, no vacío, tamaño razonable), `fresh` (posterior al inicio de la construcción; aviso si no) |
| 2. ZIP y DEX | `zip` (directorio central, **CRC de cada entrada**, sin solapes, sin cifrado/ZIP64, límites de bombas), `dex` (cabecera, tamaño, endianness, Adler-32 y SHA-1 internos), `arsc` (`resources.arsc` sin comprimir y alineado a 4), `required` |
| 3. Firma | `signature` (`apksigner verify`: v2 o v3 válida, un firmante), `cert` (= `build-info.json`), `key` (= la llave guardada del proyecto) |
| 4. SHA-256 | `integrity` (contra `build-info.json` o un hash dado por quien llama) |
| 5. Paquete único | `package` (válido, no de Automata/sistema, igual al esperado, no en `knownPackages`) |
| 6. minSdk/targetSdk/actividad | `sdk`, `version`, `launcher` (una sola actividad lanzable, `<paquete>.MainActivity`, **y la clase existe en el DEX**) |
| 7. Permisos | `permissions` (pedidos vs. aprobados; un permiso extra falla; una lista aprobada con permisos que Automata no concede, falla) |
| 8. Recursos web | `web` (los assets del APK = `build-info.json` **y** = la carpeta web verificada vuelta a leer; falta/sobra/distinto) |
| 9. Corrupto o inseguro | `zip` (`..`, rutas absolutas, `C:`, `\`, NUL, duplicados, mayúsculas repetidas, truncado, bytes añadidos), `entries` (solo manifiesto, recursos, DEX, `assets/web`, firma) |
| 10. Registro claro | cada fallo es una frase en español; `errors[]`/`warnings[]`; `--report` escribe `verification.json` |
| extra | `hardening` (sin depuración, sin HTTP, sin copias, un componente exportado, solo elementos conocidos), `secrets` (sin archivos de llave, sin credenciales en la web, **la contraseña de la firma no aparece en ninguna entrada ni en el APK**), `bridge` (el DEX no referencia `addJavascriptInterface` ni `setWebContentsDebuggingEnabled`) |

El resultado siempre lleva `functional: false` y `pending` explicando que falta A3. Si faltan herramientas, falla (`tools`) en lugar de aprobar.

## 3. APK de prueba generado y verificado

Origen: copia de `Automata Projects\gastos-del-mes-6` (HTML/CSS/JS que superaron P4 Web; el original no se tocó: 0 archivos modificados).
Ubicación: `C:\Users\cellh\Automata Projects\android-a1a2-muestra\proyecto\dist\android\` (el proyecto copiado está en `…\proyecto`, las llaves y los intermedios en `…\datos`). **Solo existe en disco: no se instaló en ningún dispositivo.**

| Dato | Valor |
|---|---|
| Archivo | `gastos-del-mes.apk`, 21 141 bytes |
| SHA-256 | `f2a9f26e7a4daf0ec22366059c481a32ad7064a242e3288e4112d4b3770be9da` |
| Paquete | `apps.local.gastos_del_mes.p521ab555` · versionCode 1 · `minSdk 26` · `targetSdk 36` |
| Permisos | ninguno |
| Certificado (SHA-256) | `12e9ab28c8b5024adb57086fe7b8ac9fe9f6c96ade6a37c1dafe9930ba18d463` (llave de desarrollo del proyecto; firma v2 + v3) |
| Contenido | manifiesto, `resources.arsc`, `classes.dex`, 3 assets web (`index.html`, `app.js`, `styles.css`), ícono |
| Verificación | **20 comprobaciones correctas, 0 errores, 0 avisos** (`verification.json` al lado) |

La construcción es reproducible: el mismo proyecto con la misma llave produce **los mismos bytes** (verificado por prueba y a mano).

**JDK 25:** la misma app se construyó y verificó también con el JBR 25.0.2 de Android Studio (`AUTOMATA_ANDROID_JAVA_HOME`): 20/20 correcto, assets idénticos; el DEX difiere (otro `javac`), así que la reproducibilidad vale por JDK, no entre JDK. `apksigner` bajo Java 25 imprime un aviso inofensivo de la JVM («restricted method…»), que el verificador muestra como aviso, no como error. Por eso el orden es JDK 21 primero y 25 solo como alternativa comprobada.

**Escenarios de `ui-check.json` con la política del envoltorio (señal previa, no sustituye A3):** la misma página y sus escenarios, servidos en Chrome con la **misma** `Content-Security-Policy`, pasan completos (11/11 escenarios `ok`, 0 problemas, 0 violaciones de la política registradas). Esto solo descarta que la política rompa la app; no dice nada de WebView.

## 4. Resultados de pruebas

- `npm test`: **315/315** (285 previas + 30 nuevas), ~36 s; corridas limpias: 3 consecutivas al final.
- **Una falla aislada** en una corrida intermedia: `processes.test.mjs` «al abrir Automata se cierran los huérfanos…» (una prueba preexistente basada en esperas de 400/500 ms y en la tabla de procesos de Windows). Pasó 3/3 sola y en las 5 corridas completas siguientes. Sospecho carga puntual por mis JVM en paralelo; por eso las verificaciones de las pruebas nuevas ahora se ejecutan una a la vez. No lo he podido reproducir, y lo dejo anotado como riesgo, no como resuelto.
- Pruebas nuevas, por tema:
  - **Validación pura (sin SDK):** paquetes (válidos/inválidos/Automata/sistema), nombre por defecto, nombre visible, permisos, manifiesto (inyección de `<service>`, `debuggable`, HTTP, escape), Activity (sin puentes ni `file://`, determinista), recolección de la web (qué entra y qué no, nombres inseguros, credenciales, archivo enorme, sin `index.html`, uniones/enlaces), más de 20 rechazos de entradas inválidas antes de ejecutar herramientas (incluida la carpeta de Automata y el directorio del usuario), identificador ya usado, sin JDK/SDK, JDK 21 antes que 25 y el 17 ignorado, herramienta que falla (etapa `java`, registro conservado, proyecto sin ensuciar), herramienta colgada cortada por tiempo.
  - **Lector ZIP:** truncado, bytes añadidos, no-ZIP, `..`, ruta absoluta, `C:`, `\`, NUL, duplicados (y por mayúsculas), cifrado, cabecera local distinta, CRC erróneo, `addToZip`.
  - **Construcción real:** APK firmado, `build-info.json`, contenido exacto del ZIP (sin `.env`, `README`, `node_modules`, llaves ni contraseña), llave fuera del proyecto y contraseña ausente del APK y del registro, solo `dist/android` añadido al proyecto, reconstrucción idéntica, segundo proyecto con paquete y certificado propios, permiso aprobado sí / no aprobado no.
  - **Verificación real:** APK bueno (20 ids), byte alterado, truncado, texto como APK, vacío, inexistente, 4 tipos de ruta insegura, web cambiada tras firmar, entradas de más (`lib/…so`, `.keystore`), contraseña de la llave dentro del APK, credencial en la web, sin `index.html`, web de origen cambiada después de construir (firma válida pero APK desactualizado), paquete/minSdk/targetSdk distintos, paquete ya usado, permiso extra y permiso no concedible, hash falso, certificado falso, APK de otro proyecto con el `build-info.json` ajeno, sin `build-info.json`, sin herramientas.
- Las pruebas con APK reales se saltan solas, diciendo por qué, si la PC no tiene JDK 21/25 y Android SDK.

## 5. Herramientas y versiones

| Pieza | Versión |
|---|---|
| JDK usado por defecto | Eclipse Adoptium **21.0.12.1** (de `~/.gradle/jdks`, solo lectura) |
| JDK alternativa comprobada | Android Studio JBR **25.0.2** |
| Android SDK Platform | `android-36` (compilación) |
| Build-Tools | **36.0.0**: `aapt2` 2.20-13193326, `d8` 8.10.9-dev, `apksigner` 0.9, `zipalign` 36.0.0 |
| `javac` | `--release 8` (constante `JAVA_RELEASE`) |
| Gradle | **ninguno** |
| Node | v24.19.0 (el lector ZIP no usa APIs de Node 24; `engines` sigue en ≥ 22) |

No se descargó ni instaló nada; no se tocó `JAVA_HOME`, el PATH, ni el SDK. Comprobado: `~/.android`, `~/.gradle/jdks` y `~/.java` quedaron como estaban (listado completo antes/después, sin diferencias). Única observación: la hora de modificación de la carpeta `~/.gradle` cambió durante la sesión sin que aparezca ninguna entrada nueva; yo solo *leo* `~/.gradle/jdks` y no ejecuté Gradle, y otros programas del usuario usan esa carpeta, así que no lo atribuyo a mi trabajo, pero tampoco puedo demostrarlo.

## 6. Limitaciones de compatibilidad del WebView (a validar en A3)

La app se sirve desde `https://appassets.local/…`, no desde `file://` ni desde `localhost`. Posibles diferencias frente a Chrome de escritorio, **ninguna comprobada en un dispositivo**:

1. **Origen distinto:** `localStorage`/IndexedDB son del APK (no se comparten con la copia de escritorio ni con otra app); una página que dependa de `file://` o que guarde datos con rutas absolutas se comporta distinto.
2. **CSP:** se permiten scripts y estilos inline, pero **`eval`/`new Function` quedan bloqueados**, `connect-src` es solo el propio origen y no hay `<iframe>` externos ni fuentes remotas.
3. **Sin red por defecto** (sin `INTERNET`): `fetch`/`XMLHttpRequest` a Internet fallan por diseño. Con `INTERNET` aprobado, el envoltorio igualmente responde 403 a todo origen ajeno: no hay contenido remoto.
4. **No soportado:** `window.open`/`target=_blank` (la navegación externa se bloquea sin abrir nada), descargas, `<input type=file>`, cámara, micrófono, geolocalización, portapapeles avanzado, compartir, imprimir, `prompt()` (devuelve el valor por defecto).
5. **Diálogos:** `alert`/`confirm` son nativos y tienen otro aspecto; no son bloqueantes del mismo modo que en el navegador.
6. **Interfaz:** `100vh` con barras del sistema, teclado y bordes (el envoltorio aplica los *insets* del sistema, **sin probar** en targetSdk 36), controles nativos de fecha/número, `toLocaleString` según el idioma del teléfono, sin modo oscuro propio, tamaño de fuente del sistema.
7. **Botón Atrás:** retrocede en el historial del WebView y, si no hay, cierra la app.
8. **Versión del WebView:** depende de «Android System WebView» del teléfono, no de Chrome de la PC; el mínimo es API 26.
9. **Java 8** como destino de `javac` está marcado como obsoleto en JDK 21/25; hoy solo da un aviso silenciado, y una futura versión que lo quite haría fallar la etapa `java` con un mensaje claro.

## 7. Riesgos conocidos

- **Nada se ejecutó en Android.** Que el envoltorio Java arranque, que la intercepción de `https://appassets.local/` funcione, que los *insets* y los diálogos se vean bien y que los escenarios web pasen en WebView es hipótesis hasta A3. Que el host use un dominio `.local` está respaldado por el mismo patrón que ya usa la app de Automata en el teléfono, pero no por una prueba de estos APK.
- **`build-info.json` no está autenticado:** quien reemplace APK *y* `build-info.json` a la vez engaña a la comprobación de integridad. Para que valga como control, el hash de referencia debería guardarlo Automata en sus propios datos al construir (A4) o pasarse como `expected.sha256`; el verificador ya lo admite.
- **Llave de firma:** protegida por estar fuera del proyecto, aleatoria y en un archivo con permisos 0600 (en Windows rige la herencia de permisos de la carpeta de datos del usuario; no se endurecen ACL). Quien lea la carpeta de datos puede firmar como el proyecto. No sirve para publicar y no se promete nada sobre tiendas.
- **Unicidad del paquete** solo se comprueba contra proyectos con llave registrada y contra la lista `knownPackages` que pase quien llama; no contra apps ya instaladas en un teléfono.
- **Dependencia de la salida de texto de `aapt2`/`apksigner`:** los analizadores se probaron con la salida actual; si una versión nueva cambia el formato, el verificador *falla* (no aprueba), pero habría que ajustarlo.
- **Git:** el APK sale a `<proyecto>/dist/android`. En un proyecto sin `.gitignore` eso deja archivos sin seguimiento que la compuerta de Git de Automata (`settleChanges`) vería; en A4 hay que decidir si se ignora o se cambia la ruta.
- **Datos de Automata:** el constructor recibe la carpeta de datos; en la integración (A4) debe ser la real de la instancia, no una improvisada.
- **Carga de pruebas:** los JVM de las pruebas nuevas sumaron carga a `npm test`; una falla aislada de una prueba de procesos preexistente apareció una vez (sección 4).
- **Carpeta de muestra:** `Automata Projects\android-a1a2-muestra` es nueva y mía; puede borrarse sin consecuencias.

## 8. Estado de Git

- Rama: `feature/p4-android-delivery` (desde `feature/p3-idea-to-project`, sin push, sin merge de ninguna rama).
- Commits de este trabajo (locales): `9ce3738` A1 (constructor + lector ZIP + pruebas), `2a469a4` A2 (verificador + CLI + pruebas), más el de ajuste de JDK explícito/pruebas serializadas y el de este reporte.
- Árbol de trabajo: limpio salvo `package-lock.json` (sin seguimiento desde antes de empezar; no lo toqué).
- `VERIFIED_TARGETS` sigue en `["web"]`; el aviso «Android todavía no se entrega» de la propuesta no cambia.

## 9. Preparación para A3 (no iniciado)

Para probar de verdad hace falta tu autorización **específica**. Propuesta mínima:

1. **Dispositivo:** Samsung `R5CY61KW8LT`, y solo estos paquetes: `apps.local.gastos_del_mes.p521ab555` (la muestra) y, si hace falta, su variante de prueba. Acciones: `adb install -r`, `pm path`/`dumpsys package`, `am start -W`, `pidof`, `logcat -b crash` y `-s AutomataWeb`, captura de pantalla, y `adb uninstall` al terminar. Nada más: no se toca la app de Automata que ya está instalada, no se usa `adb` en otros dispositivos ni emuladores.
2. **Decisión que necesito:** los escenarios de `ui-check.json` hay que ejecutarlos **dentro** del WebView, y la depuración web del envoltorio de entrega está desactivada a propósito. Opciones: **(a)** una variante de prueba (paquete `….test`, `debuggable` y depuración web activas) que solo se compila para A3, se instala en el teléfono autorizado y se desinstala; el APK de entrega no cambia (recomendada); **(b)** sin depuración, validar solo arranque, ausencia de errores en `logcat` y capturas, sin ejecutar escenarios.
3. **Condiciones:** teléfono desbloqueado y conectado; si cualquier comprobación falla o aparece un diálogo inesperado, me detengo y lo desinstalo.
4. **Se escribiría** `scripts/android-device-check.mjs` (instalar, arrancar, vigilar, desinstalar, limpiar) con pruebas con un `adb` simulado; el resultado alimentaría el `verifyApk` (`functional` seguiría en `false` hasta que A3 pase).
5. Solo después de A3 y de la corrida real de A5 se evaluaría declarar soporte Android.

**Me detengo aquí, como se pidió: A1 y A2 terminados; no se instaló nada en el Samsung ni en emuladores.**
