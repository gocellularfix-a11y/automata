# Automata

**Claude construye. Codex dirige. Tú tienes el control.**

Aplicación para coordinar proyectos: el director convierte un objetivo en tareas, Claude implementa, se ejecutan verificaciones y Codex inspecciona la evidencia antes de generar el siguiente prompt.

Una interfaz compartida para Windows y Android: dos paneles en escritorio, pestañas en móvil y controles en la parte inferior.

## Incluido en 0.3

- Proyectos con carpeta, objetivo, criterios de aceptación, restricciones y comandos de verificación.
- Tareas pequeñas, medianas o largas.
- Selección independiente de modelos y razonamiento; identificadores personalizados.
- Ciclo automático director → codificador → verificaciones → auditoría.
- Pausa en un punto seguro, cancelación, continuación y límite de rondas/tiempo.
- Consultas a Claude, Codex o ambos; instrucciones al director entre operaciones.
- Historial, reportes y recuperación de sesiones interrumpidas.
- Conexión Android a la PC mediante código de acceso.
- Demostración aislada que no llama a proveedores ni consume créditos.
- Ventana de cuentas al abrir: conecta Claude y ChatGPT/Codex mediante sus herramientas oficiales, detecta sesiones existentes y comprueba ambas antes de trabajar.
- Proyectos **Local** sin Git obligatorio y **GitHub** para clonar o usar una copia local existente. Conexión opcional de GitHub desde Cuentas.

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

- **Local**: selecciona una carpeta existente y define el objetivo. No necesitas Git, GitHub ni un repositorio inicializado. La planificación, auditoría y consultas de Codex usan `--skip-git-repo-check` y mantienen `--sandbox read-only`. No se ejecuta `git init`.
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

El auditor revisa en modo de solo lectura. El codificador conserva los permisos de Claude Code; Automata no los desactiva. Los comandos de verificación son los que defines al crear el proyecto. Commit, push y despliegue están fuera de las tareas automáticas.

La aprobación necesita evidencia para todos los criterios y verificaciones aprobadas en la ronda actual. Sigue siendo una revisión de AI: conserva las comprobaciones apropiadas para tu proyecto.

La versión 0.3.1 corrige la consola negra que podía aparecer al consultar a Codex en Windows: ejecuta directamente el binario instalado de Codex con su ventana oculta, sin pasar por el lanzador npm que abría otra consola. El chat distingue consulta en cola, respondiendo, respuesta, error e interrupción. El aviso de cola solo se muestra cuando el mensaje está esperando; al consultar a ambos agentes, cada respuesta aparece en cuanto termina su turno.

Arquitectura y fuentes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Estado de validación: [docs/VALIDATION.md](docs/VALIDATION.md).
