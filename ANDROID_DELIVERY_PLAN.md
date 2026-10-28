# Android: auditoría y plan técnico de entrega

Fecha: 28 oct 2026 · Rama `feature/p3-idea-to-project` · **Esto es un plan, no una implementación. Automata NO soporta Android todavía** (`VERIFIED_TARGETS = ["web"]`, y seguirá así hasta producir y probar un APK real). Nada se instaló ni se cambió en la configuración global; las pruebas de esta auditoría usaron carpetas temporales (ya borradas) y no se instaló ningún APK en el teléfono.

## 1. Qué existe hoy en el repositorio

- `android/` + `scripts/build-android.ps1`: construyen **la propia app de Automata** (un `WebView` que sirve `public/` desde `assets` y se conecta por USB al coordinador). El script llama `aapt2 → javac → d8 → aapt add → zipalign → apksigner` sin Gradle, con una llave de desarrollo propia, y verifica la firma.
- `scripts/smoke-phone.mjs`: instala ese APK en un teléfono por ADB y lo prueba con Playwright (`_android`).
- `server/environment.mjs` ya detecta JDK, SDK, build-tools, `apksigner`, `d8`, `adb`; `delivery.mjs` ya avisa a la persona, antes de aprobar, que Android no se entrega todavía.
- Ese script **no es un compilador genérico**: tiene rutas, paquete, `minSdk`, `debuggable` y `usesCleartextTraffic` fijos de Automata. No se reutiliza como tal; sí sirve de referencia de qué herramientas del SDK bastan.

## 2. Entorno de esta PC (medido, solo lectura)

| Pieza | Resultado |
|---|---|
| JDK 25 | Android Studio JBR `25.0.2` (con `javac`, `jar`, `keytool`) |
| JDK 21 | `C:\Users\cellh\.gradle\jdks\jdk-21.0.12.1+1` (descargado por Gradle para otros proyectos del usuario); también JDK 17 |
| Android SDK | `…\Android\Sdk`: plataformas 34, 36, 37.0; build-tools 34.0.0, 35.0.0, 36.0.0 (`aapt2`, `d8`, `zipalign`, `apksigner`); `cmdline-tools/latest`; `platform-tools` (adb 37.0.1); `emulator`; imágenes de sistema `android-36`; carpeta de licencias presente |
| Gradle | No hay uno instalado en el PATH, pero hay distribuciones ya descomprimidas por los proyectos del usuario: 8.7, 8.11.1, 8.14.3, 9.3.1 |
| Plugin de Android para Gradle (AGP) | En caché local: 8.0.0, 8.5.2, 8.7.2, 8.10.1, **8.13.0**, 8.13.2; con `aapt2` en caché solo para 8.5.2, 8.10.1 y 8.13.0 |
| Teléfono | `R5CY61KW8LT` (Samsung `SM_S938B`), autorizado, Android API **37**, `arm64-v8a`. Ya tiene instalado `app.automata.workspace` (el cliente de Automata) |
| Emuladores | Existen AVD `TerraSurvive_API36`, `cellhub_tablet`, `invoiceflow_pentest`, `jcc_test`: **son de otros proyectos del usuario; no se tocan** |
| Llave de firma | Existe `~/.android/debug.keystore` del usuario (no se usa) |

### Compatibilidad real de Gradle con JDK (tarea mínima ejecutada sin red, con directorio de Gradle temporal)

`gradle --version` **engaña**: respondió bien con todas las combinaciones. Una compilación real de `build.gradle` dio:

| Gradle | JDK 17 | JDK 21 | JDK 25 |
|---|---|---|---|
| 8.7 | ok | ok | **falla** |
| 8.11.1 | ok | ok | **falla** |
| 8.14.3 | ok | ok | **falla** («Unsupported class file major version 69») |
| 9.3.1 | ok | ok | **ok** |

### Un APK real con Gradle, sin descargar nada
Proyecto Java mínimo (una `Activity`, sin librerías), `GRADLE_RO_DEP_CACHE` apuntando a la caché del usuario (solo lectura), todo lo demás en una carpeta temporal y firma con una llave temporal propia:
- **Gradle 8.14.3 + AGP 8.13.0 + JDK 21** → `BUILD SUCCESSFUL` en 17 s, APK de 6 557 bytes. `apksigner verify`: firmado (esquema v2); `aapt2 dump badging`: paquete, `targetSdk 36`, actividad lanzadora correctos; contiene `classes.dex`, `AndroidManifest.xml`, `resources.arsc`.
- **Gradle 9.3.1 + AGP 8.13.0 + JDK 25** → también `BUILD SUCCESSFUL` y APK. Está **fuera del soporte oficial de AGP 8.13** (solo probado con una app trivial): no se puede apoyar nada en eso.
- **AGP 8.13.2** falló sin red: su `aapt2` no está en caché. Es decir, **la construcción con Gradle solo es reproducible sin descargas con las versiones ya cacheadas**; cualquier dependencia nueva (AndroidX, Kotlin, otra versión de AGP) exige red y por tanto autorización.

### El camino sin Gradle con JDK 25/21
`javac --release 8` (JDK 25) compila `MainActivity.java` a clase mayor 52 y `d8` (build-tools 36) lo convierte en `classes.dex`; con `-source 8 -target 8` también, con avisos de obsolescencia («will be removed in a future release»). Es decir, el pipeline del SDK **funciona hoy con Java 25 y 21**, pero Java 8 como destino está en vías de desaparecer: conviene fijar el destino en una constante y vigilarlo.

## 3. Decisión de diseño (la más pequeña que se puede demostrar)

**Primer objetivo: la app Android de un proyecto es un envoltorio `WebView` de su aplicación web ya verificada**, más, opcionalmente, Java de framework puro. Razones: reutiliza lo ya comprobado en P4 (la página, los escenarios `ui-check.json`, la guía), no necesita Gradle ni descargas, funciona sin red y con las herramientas que ya están, y el director sigue sin tener que entender Android. Android nativo con AndroidX/Kotlin/Compose queda **fuera** de esta versión (exige Gradle + dependencias descargadas).

**Compilador: un constructor propio y genérico (`server/androidbuild.mjs`), no `build-android.ps1`.** Entradas fijas y validadas; salidas siempre dentro de la carpeta del proyecto o de la de datos de Automata:

```
<proyecto>/android/AndroidManifest.xml     (Claude lo escribe; Automata lo valida)
<proyecto>/android/src/**/*.java            (framework de Android, sin librerías)
<proyecto>/android/res/**                   (opcional)
<proyecto>/android/assets/** o la web       (la página que ya pasó la compuerta web)
→ <proyecto>/build-android/<fecha>/…        (intermedios)
→ <proyecto>/dist/<Nombre>.apk + build-info.json (sha256, versiones de herramientas, JDK, SDK)
```

Reglas del constructor: JDK 21 si existe, si no JDK 25 con `--release 8`; sin `INTERNET` ni permisos peligrosos a menos que el manifiesto los declare y la persona los vea en la propuesta; `debuggable=false` y `usesCleartextTraffic=false` por defecto; **llave de firma propia por proyecto, guardada en los datos de Automata (no en la carpeta del proyecto ni en `~/.android`)**, de uso exclusivo para desarrollo y marcada como «no sirve para publicar»; sin publicación, sin Play Store, sin red.

## 4. Cómo se comprueba cada paso (lo que Automata ejecuta, no lo que Claude dice)

| Pregunta | Comprobación |
|---|---|
| ¿Se generó el APK? | Código de salida 0 de cada etapa; el archivo existe, pesa > 0, es posterior al inicio de la construcción; `jar tf` lista `classes.dex`, `AndroidManifest.xml` y las `assets` esperadas |
| ¿Es íntegro? | `apksigner verify --verbose --print-certs` (firma válida, esquema, sujeto del certificado); sha256 guardado en `build-info.json` y vuelto a calcular antes de instalar |
| ¿Es lo que se pidió? | `aapt2 dump badging`: paquete, `versionCode`, `minSdk ≤` API del dispositivo, actividad lanzadora igual a la del manifiesto; `aapt2 dump permissions`: solo los permisos aprobados; las `assets` web coinciden en hash con los archivos que pasaron la compuerta web |
| ¿Se instala? | `adb -s <serie> install -r` (solo con autorización explícita para ese dispositivo), `pm path <paquete>` y `dumpsys package` con el `versionCode` esperado |
| ¿Arranca? | `am start -W -n <paquete>/.MainActivity` → `Status: ok`; proceso vivo unos segundos (`pidof`); sin `FATAL EXCEPTION` en `logcat -b crash` para ese pid |
| ¿Funciona? | En apps `WebView`: los **mismos escenarios `ui-check.json`** ejecutados dentro del WebView con `_android` de Playwright (ya se usa en `smoke-phone.mjs`), más el aviso de errores de consola |
| ¿Limpio? | Desinstalar el paquete de prueba al terminar si la persona lo autoriza; ningún proceso residual en la PC (`adb` queda como lo dejó el usuario) |

## 5. Hitos (cada uno cierra con pruebas y un commit local; ninguno se declara soporte)

| # | Hito | Prueba que lo cierra | Necesita autorización |
|---|---|---|---|
| A1 | `androidbuild.mjs`: construye un proyecto fixture (Activity + res + assets) con las herramientas del SDK | Pruebas deterministas: APK válido, y casos que **deben fallar** (manifiesto roto, Java con error, recursos inválidos, SDK ausente, ruta fuera de la carpeta, permisos no aprobados) | No |
| A2 | `androidverify.mjs`: verificación estática (firma, `badging`, permisos, contenido, hash) | Pruebas con APK bueno, firma corrupta, ZIP alterado y permiso extra | No |
| A3 | Prueba con dispositivo real o emulador | Instalar, arrancar, comprobar que no falla, desinstalar | **Sí** (ver decisión 3) |
| A4 | Integración: propuesta con criterios Android (APK + guía «Instalar en tu teléfono»), compuerta de entrega, evidencia al director, fila «Tu app Android está lista» con la ruta del APK; **nunca** se instala solo | Pruebas de flujo con agentes simulados y `smoke-*` en Chrome real | No |
| A5 | **Una** corrida real idea → APK (app web envuelta) con Claude y Codex | Reporte con el APK, su `apksigner`, su `badging`, el arranque en el dispositivo y los escenarios dentro del WebView | **Sí**, la misma del A3 |
| A6 (opcional, después) | Ruta Gradle con las versiones ya cacheadas | Solo si hay una necesidad real y se autoriza descargar | Sí (red) |

**Se declara soporte Android cuando A3 y A5 muestren un APK real instalado y funcionando; antes de eso, `VERIFIED_TARGETS` no cambia** y la propuesta sigue avisando que no se entrega.

## 6. Reglas que se mantienen

Dos agentes (Codex director, Claude desarrollador); Claude con permisos limitados (escribe `android/`; el constructor y las verificaciones los ejecuta el coordinador, como ya hace con `ui-check.json` y las pruebas); memoria, recuperación, plan y verificación existentes; sin APIs de pago; sin publicación automática; sin push ni merge; sin instalar SDK ni tocar configuración global; las carpetas de evidencia se conservan.

## 7. Riesgos conocidos

- Java 8 como destino está marcado como obsoleto en JDK 21 y 25; el constructor debe tener una única constante y una prueba que avise cuando el JDK deje de aceptarlo.
- Gradle/AGP 8.13 imprimió «SDK XML version 4» al leer el SDK (que trae un formato más nuevo que el que entiende): ruido, no fallo.
- Un `WebView` abre `file://`/`https://appassets…` distinto que Chrome; los escenarios dentro del WebView son la única prueba real de que la app web se comporta igual.
- El teléfono es del usuario: instalar y desinstalar son acciones visibles; el emulador no es una opción gratuita (los AVD existentes no son nuestros; crear uno escribe en `~/.android/avd`).
- La firma de desarrollo no sirve para publicar; no se promete nada sobre tiendas.

## 8. Decisiones que necesito antes de A1

1. **¿Primer objetivo = app web envuelta en `WebView`?** (recomendado) ¿O prefieres Java nativo de framework desde el inicio?
2. **JDK:** ¿usar JDK 21 de `~/.gradle/jdks` (leerlo, sin tocarlo) o el JBR 25 con `--release 8`? (recomiendo 21 si existe, 25 como alternativa).
3. **A3/A5:** ¿autorizas instalar y desinstalar **un APK de prueba** en el teléfono `R5CY61KW8LT`? Alternativa: un AVD nuevo propio de Automata (escribe en `~/.android/avd`, también requiere tu autorización).
4. **Gradle:** ¿lo dejamos fuera de esta versión (recomendado) y solo lo reconsideramos si hace falta una dependencia?
