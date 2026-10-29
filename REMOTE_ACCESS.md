# Acceso remoto a Automata (desde casa o desde cualquier lugar)

Estado al 28 oct 2026: **probado** por Tailscale con el Samsung S25 Ultra (cliente de Automata, interfaz actual) estando el teléfono en la misma Wi-Fi que la PC. **Sin probar:** con el teléfono en datos móviles / otra red, y con el iPhone. No hay ningún servicio de terceros: solo tu red privada de Tailscale.

## Cómo funciona
- El coordinador sigue en tu PC (ahí están los proyectos, Git y las sesiones de Claude y Codex) y **escucha solo en `127.0.0.1`**. No se abre ningún puerto en el Firewall ni en el router.
- Tailscale publica ese puerto local como `https://<tu-pc>.<tu-red>.ts.net:<puerto>` (`tailscale serve`), solo dentro de tu red privada y con un certificado HTTPS válido. El teléfono necesita la app de Tailscale conectada a la misma cuenta.
- La PC debe estar encendida y despierta, con Automata abierto.

## Activarlo
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
