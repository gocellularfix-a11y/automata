# Acceso remoto a Automata (desde casa o desde cualquier lugar)

Estado al 28 oct 2026: **probado** por Tailscale con el Samsung S25 Ultra (cliente de Automata, interfaz actual), tanto en la misma Wi-Fi como **con el Wi-Fi apagado y solo datos móviles** (Tailscale lo alcanzó por relevo DERP, sin conexión directa): todas las comprobaciones correctas (conexión, código erróneo, ciclo completo, reconexión, aprobaciones, seguridad). **Sin probar:** el iPhone, y una sesión larga con el teléfono bloqueado/en segundo plano. No hay ningún servicio de terceros: solo tu red privada de Tailscale.

## Cómo funciona
- El coordinador sigue en tu PC (ahí están los proyectos, Git y las sesiones de Claude y Codex) y **escucha solo en `127.0.0.1`**. No se abre ningún puerto en el Firewall ni en el router.
- Tailscale publica ese puerto local como `https://<tu-pc>.<tu-red>.ts.net:<puerto>` (`tailscale serve`), solo dentro de tu red privada y con un certificado HTTPS válido. El teléfono necesita la app de Tailscale conectada a la misma cuenta.
- La PC debe estar encendida y despierta, con Automata abierto.

## Activarlo en la app de Windows instalada (lo normal)
1. Crea `%APPDATA%Automataemote.json` con tu dirección de Tailscale y, si quieres, tu cuenta: `{"url": "https://cellhub.tail3ce5f0.ts.net:8444", "logins": ["tu-cuenta@correo.com"]}`.
2. Publica el puerto de la app (4780) en tu red privada: `tailscale serve --bg --https=8444 http://127.0.0.1:4780`.
3. Reinicia Automata. En el diálogo de conexión del teléfono (icono del enlace) ya aparece la dirección remota y el código.
4. Para no teclear en el teléfono (Android conectado por USB): `node scripts/android-connect.mjs --serial <serie> --url https://cellhub.tail3ce5f0.ts.net:8444 --token-file "%APPDATA%Automataworkspaceaccess-token"` escribe la dirección y el código dentro del cliente sin mostrarlos.

Si otra copia de Automata ya usa el puerto 4780, la app instalada escucha en otro puerto y el paso 2 deja de apuntarle: cierra la otra copia.

## Activarlo con la línea de comandos (pruebas)
1. Arranca el coordinador con el nombre que publica Tailscale (y, si quieres, limitado a tu cuenta):
   `node server/index.mjs --port 4790 --remote-host cellhub.tail3ce5f0.ts.net --remote-login tu-cuenta@correo.com`
2. Publica el puerto en tu red privada (añade una entrada; no toca las que ya tengas):
   `tailscale serve --bg --https=8444 http://127.0.0.1:4790`
3. En el cliente (Android o Safari): dirección `https://cellhub.tail3ce5f0.ts.net:8444` y el código de acceso que muestra Automata en la PC.
4. Para quitarlo: `tailscale serve --https=8444 off`.

## Seguridad
- Todo `/api` exige el **código de acceso**; el nombre remoto solo se acepta si la petición trae las cabeceras del proxy de Tailscale, y con `--remote-login` solo desde las cuentas indicadas.
- Lo reservado a quien está sentado ante la PC **se niega a cualquier petición que llegue por un proxy**, aunque venga de `127.0.0.1`: conectar cuentas de Claude/Codex, pedir el código de emparejamiento, abrir aplicaciones y la herramienta de comprobación de Claude (`test/remote-access.test.mjs`).
- Los orígenes web aceptados son `https` del mismo nombre y el cliente Android; cualquier otro recibe 403.
- No abras el puerto del coordinador en el router ni uses túneles públicos: el código sería la única barrera y, sin cifrado de extremo a extremo, un tercero vería todo el tráfico.
- Tailscale cifra el tráfico entre tus dispositivos; quien tenga acceso a tu cuenta de Tailscale o a un dispositivo tuyo ya conectado puede intentar entrar, pero sigue necesitando el código.

## Probar el cliente por el camino remoto
`node scripts/android-client-check.mjs --serial <serie> --port 4790 --remote-url https://cellhub.tail3ce5f0.ts.net:8444 --remote-login tu-cuenta@correo.com`
(coordinador de demostración propio; instala nada).
