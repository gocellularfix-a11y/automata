# Android A3 (primera prueba en el Samsung) y estado del cliente

Fecha: 28 oct 2026 · Rama `feature/p4-android-delivery` · Sin push, sin merge · Autorización del usuario: «sí instala en los teléfonos».

## Lo que se hizo en el Samsung S25 Ultra (`R5CY61KW8LT`, SM-S938B, Android 17 / API 37, arm64)
Único dispositivo visible para `adb`. Todo con `scripts/android-device-check.mjs` (lista cerrada: solo el paquete de `build-info.json`, nunca `app.automata.*`).

| Paso | Resultado |
|---|---|
| Verificación estática previa (A2) del APK de muestra `apps.local.gastos_del_mes.p521ab555` | correcta |
| Instalación (paquete nuevo, nada pisado) | correcta · versionCode 1 · no depurable · sin permisos |
| `am start -W` | `Status: ok`, arranque en frío 203 ms |
| Proceso vivo a los 5 s; `logcat -b crash` | vivo; sin `FATAL EXCEPTION` |
| Consola de la página (`AutomataWeb`) | sin errores |
| Pantalla | la app **se ve correctamente** en el WebView: título, formulario, resumen, sin desbordes (captura revisada) |
| Entrada de texto con `adb input` en dos campos | el teclado funciona y no tapa los campos |
| Desinstalación (solo ese paquete) | correcta; `pm path` vacío |
| Cliente de Automata (`app.automata.workspace`) antes/después | **idéntico**: misma ruta, versionCode 5, fecha de actualización y firma |

Esto confirma que el envoltorio arranca y que la intercepción de `https://appassets.local/` sirve la web (la página y su CSS/JS aparecen). **No** se ejecutaron los 11 escenarios de `ui-check.json` dentro del WebView: sin la variante de depuración (decisión pendiente) solo se pudo validar arranque, consola, captura y escritura. Quedan sin probar: guardar un gasto y los totales, selector de fecha y categoría nativos, Atrás, rotación, y que `Fecha` aparece vacía (en Chrome de escritorio el escenario la rellena; hay que ver si la app espera un valor por defecto).

## Cliente Android de Automata: no se pudo actualizar
- Se compiló en la PC con JDK 21 (`scripts/build-android.ps1 -JavaHome …jdk-21`): correcto, firma v2/v3 válida, `dist/Automata-Android.apk` (197 836 bytes, sha256 `261203e8…ffd4f`). **No se había compilado con JDK 21 antes; funciona.**
- `android/build/` no existía, así que el script **creó una llave de desarrollo nueva**. `adb install -r` fue rechazado: `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (la firma instalada es otra). El rechazo no cambió nada en el teléfono.
- Para instalar esta versión habría que **desinstalar antes el cliente actual**; se pierde solo su conexión guardada (dirección y código). No lo hice: «instala» no cubre desinstalar algo existente del usuario.
- Alternativa: encontrar la llave original (no está en este repo ni en `android/build/`) — improbable.
- Consecuencia: a partir de ahora el cliente instalado y los APK compilados aquí usarán llaves distintas hasta que se haga esa desinstalación una vez.

## iPhone 13
No se instaló nada y no se podía desde Windows: no hay compilación nativa (ver `IOS_NATIVE_REQUIREMENTS.md`). La vía es Safari (y PWA después); necesita red local, regla de Firewall acotada y que tú abras la dirección en el teléfono.

## Notas
- Las capturas contienen la pantalla del teléfono (incluida una notificación de tu reproductor): quedaron solo en la carpeta temporal de la sesión, **no** en el repositorio.
- `android/build/automata-debug.keystore` es nuevo (ignorado por Git).

---
## Ronda 2 (tras «sí» a las tres preguntas)

### Hecho
- **Variante de prueba** (`--variant test`): otro paquete (`<paquete>.test`), depurable, en `dist/android/test/`, `build-info` propio con `deliverable:false`. El verificador la acepta solo si se le dice que es de prueba, y rechaza una entrega depurable o un `.test` presentado como entrega. 3 pruebas nuevas.
- **Escenarios dentro del WebView** (`scripts/android-webview-scenarios.mjs`): usa el socket de depuración del propio WebView con `adb forward` (puerto solo en la PC). **No** usa el modo Android de Playwright, que instala su propio controlador en el teléfono.
- **Resultado en el S25 Ultra** (WebView Chrome 156, 384×750 CSS px a 2,8125): **11/11 escenarios de `ui-check.json` correctos**; arranque en frío 418 ms; sin excepciones de JavaScript; sin `FATAL EXCEPTION`. Paquete de prueba desinstalado (solo ese), sin restos, `adb forward` retirado, cliente intacto (versionCode 5, misma firma y fecha).
- **Alcance real de esa prueba:** los escenarios manipulan el DOM (rellenan valores y hacen `click()`), no toques físicos: no prueban el selector nativo de fecha, el teclado numérico ni gestos. Eso queda para una pasada manual o con `adb input`.
- **Cliente instalado = interfaz vieja:** se descargó (solo lectura) el `base.apk` instalado y se comparó con el recién compilado: `app.js`, `i18n.js`, `index.html`, `styles.css` e `icon.svg` **difieren**. Es decir, el cliente del teléfono no tiene las pantallas de P3/P4 (p. ej. «Tu aplicación está lista»). Actualizarlo es necesario, no cosmético.

### Bloqueado (no lo rodeé)
1. **Desinstalar `app.automata.workspace`:** el sistema de permisos de Claude Code denegó el comando (sin explicación). No intenté otra vía. Para continuar: o lo ejecutas tú, o añades una regla de permiso para ese comando exacto.
2. **Regla de Firewall:** esta sesión no es administrador (`Administrador: False`), así que necesita un PowerShell elevado tuyo.

### Datos de red medidos
Wi-Fi `GOCELLULAR 2` (perfil **Privado**), PC en `192.168.50.167`; también hay un adaptador Tailscale (`100.107.206.48`). Si esa Wi-Fi es la del negocio, tenerla como «de confianza» incluye a cualquiera conectado a ella: el código de acceso es la única barrera (va sin cifrar por HTTP).
