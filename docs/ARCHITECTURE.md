# Automata 0.4.0

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

Cada ejecución conserva una copia de la definición del proyecto y de los modelos elegidos. Los cambios de modelo se aplican al siguiente trabajo; idioma y permisos se aplican a la siguiente operación. Para ampliar un límite alcanzado se actualiza el máximo y se continúa explícitamente.

Los comandos de verificación deben pertenecer a la ronda actual para aprobar. `complete` exige evidencia no vacía para todos los criterios originales y ningún hallazgo crítico/importante pendiente. El coordinador rechaza una aprobación si falló un comando. La inspección de AI sigue siendo falible: estas reglas comprueban el contrato, no prueban por sí solas la corrección del código.

## Permisos y datos

`accessMode=full` es el permiso solicitado para ambos agentes. Claude se inicia con `--permission-mode bypassPermissions`, sin una lista de herramientas que lo reduzca a lectura; Codex usa `--dangerously-bypass-approvals-and-sandbox`. Esto permite operaciones de archivo, comandos y red bajo la cuenta del proceso. No modifica las restricciones del entorno donde se desarrolla Automata, no eleva privilegios y no cambia políticas administradas de Windows/proveedor. `limited` conserva el comportamiento anterior. Las consultas `question` siempre usan modo de lectura, de forma explícita.

Los proyectos locales no requieren repositorio: las invocaciones de Codex exec incluyen `--skip-git-repo-check`. La evidencia Git es opcional; status y diff se limitan a la carpeta del proyecto con un pathspec. El modo completo permite inicializar o crear un repositorio cuando el usuario lo pide, sin convertir Git en un requisito para trabajar.

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

## Local y GitHub (0.3.0)

`source` es `local` por defecto; los proyectos guardados antes de 0.3 siguen funcionando sin migrar sus carpetas. GitHub añade una URL canónica del repositorio, con validación estricta de HTTPS, host, owner y repo, sin credenciales ni parámetros.

`server/github.mjs` prepara la importación antes de registrar el proyecto. Clonar exige carpeta existente vacía y cuenta disponible en GitHub CLI; ejecuta `gh repo clone` con argumentos separados, sin shell, sin prompts de terminal y con tiempo límite. Un fallo no registra el proyecto ni borra archivos parciales. Solo se permite una importación simultánea y cerrar Automata aborta su proceso. Usar una copia existente verifica raíz y `origin` sin cambiarlos ni solicitar credenciales de red.

La cuenta GitHub es opcional en la ventana de cuentas: no cambia el contador ni el requisito de las dos AI. El login oficial por navegador/dispositivo y su estado se gestionan mediante GitHub CLI. La CLI conserva sus credenciales; Automata no solicita tokens ni registra su salida de login. Los enlaces y códigos de acceso permanecen limitados a la PC. No se incluyen creación de repositorios remotos, commit, push ni despliegue automático.

Fuentes: [Codex fuera de Git](https://learn.chatgpt.com/docs/non-interactive-mode#git-repository-required), [login de GitHub CLI](https://cli.github.com/manual/gh_auth_login), [estado de GitHub CLI](https://cli.github.com/manual/gh_auth_status), [clonar un repositorio](https://cli.github.com/manual/gh_repo_clone).

## Inicio de Windows (0.1.1)

El error de pantalla blanca se reprodujo en el paquete real: Windows rechazaba la creación del token restringido de Chromium (`launch-failed`, código 49). El recurso HTML ni siquiera llegaba a ejecutarse. El primer paquete no había superado esta prueba y no debía describirse como listo.

La aplicación intenta primero el renderer con sandbox. Si Windows devuelve exactamente el código 49, guarda una preferencia de compatibilidad y se reinicia una vez con `sandbox: false`. Conserva `contextIsolation: true`, `nodeIntegration: false`, el puente IPC con validación de emisor, CSP y navegación exclusivamente local. La cabecera y Preferencias indican este modo. Se puede impedir con `--strict-renderer` o pedir explícitamente con `--compatibility`.

Los registros de inicio están en `boot.log` dentro de los datos de usuario. Se registran fallos de preload, carga y renderer. El cierre tiene un límite para no dejar un proceso invisible reteniendo el bloqueo de instancia.

## Procesos y consultas Windows (0.3.1)

El lanzador npm de Codex encontrado en la PC inicia el binario nativo mediante otro `spawn` sin `windowsHide`. Ocultar solo el primer proceso no ocultaba ese hijo. En Windows, Automata ahora resuelve el paquete opcional de arquitectura y ejecuta su `codex.exe` directamente con pipes y `windowsHide: true`, conservando los metadatos de instalación npm. Esto se aplica a consultas, planificación, auditoría y estado/login. Las rutas de instalación antiguas con `vendor/.../codex/codex.exe` también se detectan; los overrides de CLI explícitos siguen teniendo prioridad.

Una consulta cambia de `queued` a `processing` con `activeRole` al iniciar su turno. La API devuelve ese estado real y la UI ya no deduce la cola de `busy`, porque una consulta que está respondiendo también ocupa al coordinador. Las respuestas parciales a ambos agentes se publican al terminar cada turno. Un error libera al agente y queda en el panel. Al reabrir, las consultas que estaban procesándose se marcan interrumpidas, sin reenviarlas automáticamente.

## Tareas directas y permisos (0.4.0)

`task` ejecuta una petición desde el chat y devuelve texto, sin exigir el esquema JSON de revisión ni un ciclo activo. `question` mantiene consulta de solo lectura y `instruction` se entrega al plan activo. El destino puede ser coder, auditor o ambos; la cola serializa sus llamadas y pasa las respuestas previas al siguiente agente. Cada llamada conserva sus permisos y el resultado declara errores reales, sin sustituirlos por éxito.

Los modelos y límites de un trabajo se conservan en su snapshot. Un cambio explícito del permiso actualiza el permiso de las siguientes operaciones del trabajo activo; los argumentos del proceso ya iniciado no cambian. Los trabajos anteriores sin ese campo adoptan la selección actual al cargar.

Una tarea directa entregada justo antes de revisar invalida los checks de esa ronda. En revisiones con permiso completo se vigila el directorio del proyecto, excluyendo el almacenamiento propio, `.git`, `.automata` y `node_modules`. Si el director cambia archivos, no se acepta `complete`: se solicita otra entrega y se repiten los checks, con el mismo límite de rondas. Esto evita aprobar modificaciones con resultados anteriores; sigue sin certificar por sí solo la corrección del código.

Fuentes: [permisos de Claude Code](https://code.claude.com/docs/en/permissions) y [CLI de Codex](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Idiomas y configuración (0.4.0)

`settings.language` acepta `es` o `en`. El coordinador persiste la elección y la comparte por eventos con Windows y Android. Los prompts solicitan las próximas respuestas en ese idioma y conservan literalmente los criterios de aceptación. Las llamadas ya iniciadas conservan su snapshot. La interfaz recuerda el idioma localmente incluso antes de conectarse; el coordinador es la fuente de la preferencia al establecer conexión.

`public/i18n.js` traduce los textos de interfaz y atributos accesibles. No traduce mensajes del usuario, nombres de proyecto, rutas, criterios ni respuestas históricas. Configuración reúne los controles de idioma, permisos, modelos con identificadores personalizados, razonamiento, ritmo y límites; también permite abrir cuentas y conexión. Las opciones de razonamiento se recalculan cuando cambia el modelo.

## Fuentes utilizadas

- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/models
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/model-config
- https://www.electronjs.org/docs/latest/tutorial/security
- https://developer.android.com/develop/ui/views/layout/webapps/webview
- https://developer.android.com/tools/aapt2
