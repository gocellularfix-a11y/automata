# Automata 0.2.0

Una interfaz compartida para Windows y Android; un coordinador que trabaja en la PC.

## Componentes

- `public/`: interfaz adaptable, sin frameworks ni peticiones a CDNs. Dos paneles en escritorio y pestañas en móvil.
- `server/`: coordinador Node, persistencia local, procesos de agentes y verificaciones. Usa módulos estándar; no necesita paquetes de servidor.
- `desktop/`: aplicación Electron con contexto aislado, renderer sin Node y un puente IPC limitado. Un protocolo seguro `automata://app` sirve los recursos empaquetados; no abre un navegador externo.
- `android/`: aplicación Android con WebView del sistema, recursos empaquetados y sin puente JavaScript a Java. Se conecta a la PC.
- `Start-Automata.ps1`: entrada PowerShell para escritorio o coordinador sin interfaz.

Flutter no estaba instalado. Se implementó una interfaz compartida con Electron y un contenedor Android para compilar con las herramientas existentes. No hay una segunda interfaz móvil que mantener.

## Máquina de estados

`plan → code → checks → review → code… → complete | blocked | limit`

Solo un proceso de agente se ejecuta a la vez. El director inicial y el auditor son Codex. Las consultas a ambos se serializan. Pausar espera el final de la operación actual; detener cancela el proceso activo. Una interrupción del codificador se recupera verificando y auditando el trabajo parcial.

Cada ejecución conserva una copia de la definición del proyecto y de los modelos elegidos. Cambiar preferencias no cambia una ejecución en marcha. Para ampliar un límite alcanzado se actualiza el máximo y se continúa explícitamente.

Los comandos de verificación deben pertenecer a la ronda actual para aprobar. `complete` exige evidencia no vacía para todos los criterios originales y ningún hallazgo crítico/importante pendiente. El coordinador rechaza una aprobación si falló un comando. La inspección de AI sigue siendo falible: estas reglas comprueban el contrato, no prueban por sí solas la corrección del código.

## Permisos y datos

Codex se invoca con `--sandbox read-only`. Claude usa `acceptEdits`; Automata permite herramientas de archivo y lectura de Git, sin saltarse los permisos de la CLI. Las verificaciones configuradas por la persona se ejecutan desde PowerShell en la carpeta del proyecto. No se evalúan comandos recibidos en el JSON del auditor.

La PC escucha solo en loopback por defecto. `--lan` habilita la red local. Todos los endpoints API requieren un token aleatorio. El código para emparejar se muestra solo en la PC autenticada. El APK guarda la conexión en el almacenamiento privado de su WebView, no las credenciales de los proveedores.

El modo LAN admite HTTP para una red local de confianza; para acceso por Internet se debe usar HTTPS mediante una conexión privada o un proxy autenticado. No se incluye un servicio de nube ni un túnel público.

Los datos se guardan en `%APPDATA%/Automata/workspace` en escritorio y en `.automata/live` al ejecutar el servidor desde el repositorio. La demostración usa un directorio separado. Los prompts, reportes, sesiones y eventos se guardan localmente, fuera del control de versiones. Los reportes pueden contener código del proyecto.

## Modelos

Se incluyen los alias Haiku, Sonnet, Opus y Fable, y los identificadores `gpt-6.1-sol`, `gpt-6-luna` y `gpt-6-astra`. Se pueden introducir otros identificadores. Las listas son opciones de configuración, no una certificación de acceso en las cuentas del usuario. Cada CLI decide disponibilidad y niveles admitidos; los errores se muestran y no se sustituyen por respuestas simuladas.

El razonamiento interno no se muestra. Los paneles contienen mensajes visibles, actividad de herramientas, reportes, verificaciones y decisiones. Los tokens se muestran solo cuando la CLI los reporta.

## Conexión de cuentas (0.2.0)

`server/auth.mjs` consulta `claude auth status --json` y `codex login status`. Distingue instalación ausente, sesión pendiente, desconexión, error y sesión disponible; no deduce autenticación porque exista un ejecutable o un archivo. Antes de iniciar o reanudar un trabajo real se vuelven a comprobar las dos cuentas. Las consultas comprueban el destinatario correspondiente. La demostración omite los proveedores.

La ventana de cuentas aparece al abrir un espacio real y se puede reabrir desde **Cuentas**. Inicia las CLI oficiales (`claude auth login --claudeai`, `codex login`, alternativa `codex login --device-auth`) sin un shell y muestra sus páginas oficiales en el navegador del sistema. Para el retorno manual de Claude se mantiene stdin abierto, aceptando únicamente el código solicitado. El login tiene tiempo límite, cancelación y cierre de su proceso al salir de Automata. Cambiar de cuenta mientras hay trabajo activo está bloqueado.

El endpoint `/api/auth` requiere el token del coordinador. Las mutaciones de acceso y los enlaces/códigos pendientes están limitados a loopback y no se exponen al origen Android. Solo se ofrecen URLs HTTPS de hosts oficiales permitidos. Los datos temporales del login no se guardan en disco, eventos, historial ni localStorage. Las credenciales persistentes y su renovación pertenecen a las CLI; Automata no implementa ni suplanta su servidor OAuth. La comprobación local de credenciales no verifica la disponibilidad de modelos, cuotas ni la vigencia remota de la cuenta.

Fuentes: [Autenticación de Codex](https://learn.chatgpt.com/docs/auth), [CLI de Claude Code](https://code.claude.com/docs/en/cli-reference) y [Autenticación de Claude Code](https://code.claude.com/docs/en/authentication).

## Inicio de Windows (0.1.1)

El error de pantalla blanca se reprodujo en el paquete real: Windows rechazaba la creación del token restringido de Chromium (`launch-failed`, código 49). El recurso HTML ni siquiera llegaba a ejecutarse. El primer paquete no había superado esta prueba y no debía describirse como listo.

La aplicación intenta primero el renderer con sandbox. Si Windows devuelve exactamente el código 49, guarda una preferencia de compatibilidad y se reinicia una vez con `sandbox: false`. Conserva `contextIsolation: true`, `nodeIntegration: false`, el puente IPC con validación de emisor, CSP y navegación exclusivamente local. La cabecera y Preferencias indican este modo. Se puede impedir con `--strict-renderer` o pedir explícitamente con `--compatibility`.

Los registros de inicio están en `boot.log` dentro de los datos de usuario. Se registran fallos de preload, carga y renderer. El cierre tiene un límite para no dejar un proceso invisible reteniendo el bloqueo de instancia.

## Fuentes utilizadas

- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/models
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/model-config
- https://www.electronjs.org/docs/latest/tutorial/security
- https://developer.android.com/develop/ui/views/layout/webapps/webview
- https://developer.android.com/tools/aapt2
