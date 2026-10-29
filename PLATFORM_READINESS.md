# Instalar Automata en Windows, Android e iOS: qué está listo y qué hay que mantener

Fecha: 28 oct 2026 · Rama `feature/p4-android-delivery` · Sin push, sin merge. El iPhone queda en pausa por decisión del usuario; nada se instaló ni cambió en ningún teléfono en este paso.

## 1. Qué significa «instalar» cada cosa

Automata tiene dos partes distintas y no se instalan igual:

| Parte | Qué hace | Dónde puede vivir hoy |
|---|---|---|
| **Coordinador** (`server/`) | Ejecuta a Claude y Codex, guarda proyectos, Git y las sesiones de cada cuenta | **Solo en una PC con Windows** (usa las CLI instaladas, rutas y procesos de Windows). No hay plan de moverlo a un teléfono ni a la nube: los agentes necesitan tu PC |
| **Cliente** (`public/`, la interfaz) | Pantalla para ver y aprobar | Windows (app de escritorio), Android (APK), cualquier navegador (Safari en iOS incluido) |

Por tanto, «instalar Automata en Android o iOS» es instalar el **cliente** que se conecta a tu PC (por la misma red o por Tailscale, ver `REMOTE_ACCESS.md`). Si en algún momento se quisiera que los agentes corran en el teléfono, eso es otro proyecto distinto y no está en ningún plan.

## 2. Estado por plataforma

| Plataforma | Vía | Estado | Qué falta |
|---|---|---|---|
| **Windows** | App de escritorio (Electron 42.1.0): `npm run build:windows` deja `dist/Automata-Windows/Automata.exe` portable | Existe y fases anteriores lo cubrieron con `smoke-desktop`; **hoy no se volvió a construir ni a probar**. **Sin instalador y sin firmar** (Windows SmartScreen avisará) | Instalador (requiere una herramienta de empaquetado o certificado de firma de código: ambos son decisión y coste tuyos) |
| Windows | Instalar como app web desde Edge/Chrome | Chrome da la interfaz por **instalable** (`scripts/pwa-check.mjs`: manifiesto sin errores, 0 errores de instalabilidad) | No se hizo la instalación real en Edge |
| **Android** | Cliente APK (`app.automata.workspace`) | Compilado con JDK 21, instalado en el Samsung y **validado** por USB y por Tailscale (datos móviles): conexión, reconexión, progreso, aprobaciones, seguridad | Es una compilación de desarrollo (depurable, HTTP permitido). Llave de firma sin respaldo. Variante de entrega y, si algún día se quiere, Play Store (cuenta y políticas aparte) |
| Android | Instalar como app web desde Chrome | Mismos criterios de instalabilidad cumplidos en Chrome de escritorio | No probado en el teléfono |
| **iOS** | Añadir a pantalla de inicio desde Safari (PWA) | **Preparada**: manifiesto, iconos (180 opaco, 192, 512, maskable) y metadatos para iOS. El acceso remoto da HTTPS válido | **No probada en el iPhone** (en pausa). iOS guarda aparte el almacenamiento de la app añadida, así que hay que volver a conectar |
| iOS | App nativa | Solo documentada: `IOS_NATIVE_REQUIREMENTS.md` | Un Mac con Xcode, cuenta de Apple y firma. **No se compila desde Windows y no se promete** |

## 3. Qué se hizo en este paso (para que siga siendo posible)
- `public/manifest.webmanifest` y los iconos `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` y `apple-touch-icon.png` (180×180 opaco: iOS pone negras las esquinas transparentes), generados desde `icon.svg` con el Chrome de la PC, sin dependencias.
- Metadatos en `public/index.html` (`manifest`, `apple-touch-icon`, `apple-mobile-web-app-*`, `mobile-web-app-capable`).
- `test/pwa.test.mjs` (3 pruebas) fija el manifiesto, los tamaños de los iconos, los metadatos y que el coordinador los sirve sin código con el tipo correcto. `scripts/pwa-check.mjs` le pregunta a Chrome mismo si es instalable.
- Nada de esto cambia cómo se ve o se comporta la interfaz; el cliente Android instalado en el Samsung lleva la interfaz anterior a estos archivos, que no necesita.

## 4. Reglas para no cerrar ninguna puerta (a respetar en cada cambio)
1. **Una sola interfaz** (`public/`) para las tres plataformas. Lo específico de una plataforma vive solo en cápsulas delgadas (`desktop/main.cjs`, el `MainActivity` del cliente Android). Nada de funciones que solo existan en una.
2. **La interfaz solo usa estándares web** que soportan Chrome, Edge, WebView de Android y Safari de iOS. Cada cambio de interfaz se mira en un ancho de móvil (hoy 384 px) y sin desbordes.
3. **El coordinador es la única fuente de verdad.** Los clientes no guardan estado importante (hoy solo la conexión y el proyecto elegido). Así Windows, Android e iOS siempre muestran lo mismo.
4. **Conexión remota siempre con HTTPS y código** (Tailscale). Nunca puertos abiertos al Internet. Lo reservado a la PC rechaza todo lo que llegue por un proxy (`test/remote-access.test.mjs`).
5. **Versiones compatibles.** El cliente Android lleva la interfaz **empaquetada**; ya se vio que un cliente viejo queda con una pantalla desfasada frente al coordinador nuevo. Recomendado (no hecho): que el cliente avise «actualiza» cuando `capabilities.version` no coincida, y que pueda cargar la interfaz desde el propio coordinador cuando lo alcanza (así Safari, Chrome y el cliente Android siempre ven la versión del coordinador).
6. **Llaves y cuentas fuera del repositorio:** llave del cliente Android, certificado de firma de Windows y, si se llega, la cuenta de Apple. Respaldadas por ti.
7. **Cada plataforma tiene su prueba real** antes de decir «funciona»: Windows (`smoke-desktop`), Android (`android-client-check`, `android-device-check`), web/PWA (`pwa-check`, y la prueba en el teléfono cuando se retome el iPhone).

## 5. Pendientes y decisiones tuyas
1. Retomar el iPhone cuando quieras: Safari con `https://cellhub.tail3ce5f0.ts.net:8444` y, si funciona, «Añadir a pantalla de inicio».
2. ¿Instalador de Windows? Exige elegir herramienta y, para evitar el aviso de SmartScreen, un certificado de firma de código de pago.
3. ¿Avisar «actualiza» al cliente cuando su versión no coincida con la del coordinador, y cargar la interfaz desde el coordinador? (Recomendado antes de entregar a otras personas.)
4. Guardar una copia de `android/build/automata-debug.keystore`.
5. Arreglar el texto cortado de la tarjeta «El director propone» en el móvil.
