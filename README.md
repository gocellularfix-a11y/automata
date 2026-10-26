# Automata

**Claude construye. Codex dirige. Tú tienes el control.**

Aplicación para coordinar proyectos: el director convierte un objetivo en tareas, Claude implementa, se ejecutan verificaciones y Codex inspecciona la evidencia antes de generar el siguiente prompt.

Una interfaz compartida para Windows y Android: dos paneles en escritorio, pestañas en móvil y controles en la parte inferior.

## Incluido en 0.4

- Proyectos con carpeta, objetivo, criterios de aceptación, restricciones y comandos de verificación.
- Tareas pequeñas, medianas o largas.
- Selección independiente de modelos y razonamiento; identificadores personalizados.
- **Equipo de agentes** (botón «Equipo»): de 1 a 3 codificadores de Claude que se turnan por ronda y de 1 a 2 directores/auditores de Codex. El primero planifica y revisa; si aprueba, el siguiente confirma, y todos deben coincidir para completar. Cada agente tiene su propio modelo y nivel de razonamiento; el cambio aplica al siguiente trabajo.
- Ciclo automático director → codificador → verificaciones → auditoría.
- Pausa en un punto seguro, cancelación, continuación y límite de rondas/tiempo.
- Consultas a Claude, Codex o ambos; instrucciones al director entre operaciones.
- Historial, reportes y recuperación de sesiones interrumpidas.
- Conexión Android a la PC mediante código de acceso.
- Demostración aislada que no llama a proveedores ni consume créditos.
- Ventana de cuentas al abrir: conecta Claude y ChatGPT/Codex mediante sus herramientas oficiales, detecta sesiones existentes y comprueba ambas antes de trabajar.
- Proyectos **Local** sin Git obligatorio y **GitHub** para clonar o usar una copia local existente. Conexión opcional de GitHub desde Cuentas.
- Acceso completo para el ejecutor y tareas directas desde el chat con **Trabajar**. **Solo consultar** conserva la lectura explícita.
- **El director (Codex) es de solo lectura**: inspecciona y decide qué cambios hacer; el ejecutor (Claude) escribe todo el código. Una tarea dirigida al director se le entrega después al ejecutor.
- **El director decide cuándo hacer commit, push y merge** (campo `git` de cada revisión). Por defecto los commits son automáticos y el push y el merge esperan tu aprobación en la tarjeta «El director propone»; en Configuración puedes pasar a todo automático, todo con aprobación o desactivarlo. Nunca fuerza ni borra ramas y deja fuera los archivos con secretos.
- **Un repositorio por proyecto**: configura tu **carpeta de proyectos**; **Repositorio nuevo** crea su propia carpeta con Git (y, si quieres, un repositorio privado en GitHub) y los clones se guardan cada uno en su subcarpeta.
- **Terminal del ejecutor**: comandos, diffs y código con su salida en vivo, como en una terminal.
- **Flujo más ágil**: Claude y Codex retoman su sesión entre rondas y, si fallan las verificaciones, el ejecutor corrige directamente sin esperar al director (ambos ajustables).
- **English / Español** desde **Configuración / Settings**: interfaz, avisos y próximas respuestas de los agentes. Los mensajes originales y reportes anteriores se conservan.
- Configuración reúne idioma, permisos, modelos y razonamiento de ambas AI, ritmo, rondas, tiempo máximo, cuentas y conexión al teléfono.

## Abrir en Windows

Con Node.js 22 o posterior y PowerShell:

```powershell
npm install
.\Start-Automata.ps1
```

Para probar un ciclo con un proyecto aislado:

```powershell
.\Start-Automata.ps1 -Demo
```

También se puede abrir `dist/Automata-Windows/Automata.exe` después de generar el paquete portable. No muevas solo el EXE: conserva su carpeta completa.

Abre **Automata.exe**, sin abrir un navegador. La versión 0.1.1 corrige la pantalla blanca de Windows: carga recursos con un protocolo local propio y recupera el error de inicio de proceso 49 con un modo de compatibilidad. El lanzador Chrome anterior se retiró del paquete.

El modo de compatibilidad mantiene el contexto aislado, Node deshabilitado en la página y la navegación limitada a los recursos locales; desactiva el sandbox de proceso de Chromium cuando Windows no permite crearlo. Se identifica en la cabecera y en Preferencias. `--strict-renderer` permite exigir el sandbox sin recuperación automática.

Para trabajar con AI reales, instala Claude Code y Codex CLI. Abre **Cuentas** en Automata: se comprobarán las sesiones existentes en la PC. Si falta alguna, pulsa **Conectar con Claude** o **Conectar con ChatGPT** y completa el acceso en el navegador oficial. Automata inicia `claude auth login --claudeai` y `codex login`; las propias herramientas guardan las credenciales. No escribas tu contraseña en Automata.

Si Claude muestra un código de retorno, la ventana permite pegarlo cuando la CLI lo solicita. Codex también ofrece **Ayuda para conectar → Conectar con código de dispositivo** (`codex login --device-auth`); este método debe estar habilitado en la cuenta o workspace. Puedes cancelar un acceso pendiente. Al terminar, la conexión se confirma ejecutando el comando de estado de la herramienta, sin gastar una llamada a un modelo.

Los enlaces OAuth y códigos solo se mantienen en memoria mientras dure el acceso, sin agregarlos a reportes ni al almacenamiento de proyectos. En Android se muestra el estado; las cuentas se conectan desde Windows. Automata comparte las sesiones que ya usan las CLI en esa PC. Elegir un modelo no garantiza acceso en tu cuenta. Una sesión de Codex en Automata tiene su propio contexto; no hereda otra conversación de ChatGPT.

## Android

1. En Windows, abre Automata con `.\Start-Automata.ps1 -Lan`.
2. Pulsa el icono de teléfono para consultar la dirección y el código.
3. Instala el APK de desarrollo `dist/Automata-Android.apk`.
4. Pulsa «Conectar PC» en Android e introduce la dirección y el código.

La PC conserva los archivos, ejecuta los agentes y debe permanecer encendida. El acceso fuera de la red local requiere una conexión privada/HTTPS; Automata no publica tu PC en Internet.

## Local o GitHub

En **Nuevo proyecto**, elige:

- **Local**: selecciona una carpeta existente y define el objetivo. No necesitas Git, GitHub ni un repositorio inicializado. Codex usa `--skip-git-repo-check`. Las consultas explícitas y el director en modo limitado mantienen `--sandbox read-only`; en acceso completo ambos agentes pueden ejecutar las tareas solicitadas. Agregar un proyecto local no ejecuta `git init`.
- **GitHub → Clonar en una carpeta vacía**: instala Git y GitHub CLI, conecta GitHub en **Cuentas** e introduce `usuario/repositorio` o una URL HTTPS de GitHub. Elige una carpeta existente y vacía. Automata usa `gh repo clone`; los archivos se trabajan en tu PC.
- **GitHub → Usar una copia local existente**: selecciona la raíz de tu copia e indica el repositorio. Automata comprueba que `origin` coincida; no vuelve a clonar ni cambia el remoto. Esta opción no necesita un nuevo login de GitHub.

La conexión opcional usa `gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key` y la CLI guarda la sesión. No se crean repositorios remotos ni se hacen commits, push o publicaciones automáticamente. La cuenta de GitHub no es necesaria para trabajar en Local. Para continuar un trabajo que falló por el requisito de Git, cierra la versión anterior, abre el EXE actualizado y pulsa **Continuar**.

## Verificar y compilar

```powershell
npm test
npm run smoke
node scripts/smoke-desktop.mjs
node scripts/smoke-auth.mjs
node scripts/smoke-github.mjs
node scripts/smoke-chat.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-console.ps1 -CompareWrapper
node scripts/smoke-recovery.mjs --live
npm run build:windows
npm run build:android
```

Para actualizar un paquete Windows ya generado: `node scripts/build-windows.mjs --refresh`.

Las pruebas de interfaz requieren Chrome, o `CHROME_PATH`. La prueba nativa requiere un entorno Windows que permita los subprocesos de Electron. Las compilaciones Android usan JDK 17, Android SDK Platform 36 y Build Tools, sin Gradle ni descargas durante la compilación:

```powershell
.\scripts\build-android.ps1 -Sdk 'C:\ruta\Android\Sdk' -JavaHome 'C:\ruta\jdk-17'
```

El APK usa una firma de desarrollo local; no es una publicación en Google Play.

## Datos y límites

El escritorio guarda proyectos y reportes en su carpeta de datos de usuario. El servidor usa `.automata/`. Estos archivos, los resultados de pruebas y los paquetes generados están excluidos de Git. No se incluyen proyectos de Blueprint.

El control **Permisos** afecta a ambos agentes. **Acceso completo** permite archivos, comandos y red con los permisos de tu usuario de Windows: Claude usa `bypassPermissions` y Codex `--dangerously-bypass-approvals-and-sandbox`. No concede privilegios de administrador ni supera políticas del sistema o del proveedor. **Acceso limitado** conserva el director de lectura y Claude con edición acotada. Cambiar permisos se aplica a la siguiente operación, sin cambiar el proceso que ya está ejecutándose.

El chat abre en **Trabajar**: una petición de implementar se ejecuta por el agente elegido sin exigir iniciar primero el ciclo. Con **Ambos**, cada uno recibe el resultado anterior para no repetir acciones. **Solo consultar** es una elección explícita de lectura, incluso si el permiso global es completo. **Al plan** entrega instrucciones al director de un trabajo activo. Crear repositorios, commit, push o despliegue se permiten cuando forman parte de la petición del usuario; GitHub usa la sesión conectada de GitHub CLI. Si no indicas visibilidad para un repo nuevo, el prompt pide crearlo privado.

Los comandos de verificación son los que defines al crear el proyecto. Si una tarea directa o el director cambian archivos después de las comprobaciones, Automata exige nuevas verificaciones antes de aprobar.

La aprobación necesita evidencia para todos los criterios y verificaciones aprobadas en la ronda actual. Sigue siendo una revisión de AI: conserva las comprobaciones apropiadas para tu proyecto.

La versión 0.3.1 corrige la consola negra que podía aparecer al consultar a Codex en Windows: ejecuta directamente el binario instalado de Codex con su ventana oculta, sin pasar por el lanzador npm que abría otra consola. El chat distingue consulta en cola, respondiendo, respuesta, error e interrupción. El aviso de cola solo se muestra cuando el mensaje está esperando; al consultar a ambos agentes, cada respuesta aparece en cuanto termina su turno.

Arquitectura y fuentes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Estado de validación: [docs/VALIDATION.md](docs/VALIDATION.md).
