# App iOS nativa: herramientas, firma y requisitos de Apple

Fecha: 28 oct 2026 · **Documento de requisitos. No hay compilación iOS en Automata, no se prometió ni se probó ninguna.** Se escribe aparte porque la primera vía para el iPhone 13 es la interfaz móvil en Safari y, si se decide, una PWA (ver `MOBILE_CLIENTS_VALIDATION_PLAN.md`). Esto solo aplica si esa vía no basta.

**Aviso de fiabilidad:** lo que sigue es conocimiento general sobre las reglas de Apple a la fecha de mi información; las condiciones (versiones mínimas de Xcode, precios, límites de cuentas gratuitas, política de revisión) cambian con frecuencia. **Hay que confirmarlas en la documentación oficial de Apple antes de decidir o presupuestar.** Nada de esto se verificó en esta PC ni con el iPhone.

## 1. Qué se puede y qué no desde Windows

| Tarea | Desde Windows | Comentario |
|---|---|---|
| Compilar una app iOS (Xcode, SDK de iOS, enlazado) | **No** | Las herramientas oficiales solo existen en macOS. No hay una cadena soportada por Apple para compilar iOS nativo en Windows. |
| Firmar una app iOS con certificados de Apple | Parcial | Se puede *volver a firmar* un `.ipa` ya compilado con herramientas de terceros, pero el binario original necesita un Mac. |
| Instalar un `.ipa` ya firmado en un iPhone | Con herramientas de terceros (AltStore, Sideloadly y similares) o con las de Apple para Windows | Siguen necesitando la cuenta de Apple, y modifican el teléfono (perfiles, «Modo de desarrollador»). |
| Inspeccionar el Safari/WebView del iPhone (Inspector web) | **No** | Necesita Safari en un Mac. |
| Usar la web en Safari o como PWA | **Sí** | Es la vía que se evalúa primero. No requiere cuenta de desarrollador. |

**Por tanto:** no se promete ni se prueba una app nativa iOS desde esta PC. Con la información actual, una app nativa depende de tener acceso a un Mac (o a un servicio de Macs en la nube) y de decisiones de coste y cuenta.

## 2. Qué haría falta para una app nativa

1. **Un Mac con macOS** compatible con la versión de Xcode que exija el SDK vigente de iOS, **Xcode** y sus herramientas de línea de comandos. (Un Mac propio, uno prestado o un Mac alquilado/CI; este último implica subir el código a un servicio externo, que Automata hoy no hace sin autorización.)
2. **Una cuenta de Apple:**
   - Gratuita (Apple ID): permite instalar en *tu propio* iPhone desde Xcode con un perfil de aprovisionamiento personal que **caduca en unos días** y con límites en cantidad de apps e identificadores.
   - Apple Developer Program (de pago, anual): necesaria para TestFlight, distribución ad hoc con más margen y App Store.
3. **Firma:** identificador de app (*Bundle ID*) único, certificado de desarrollo, **perfil de aprovisionamiento** que incluya el identificador del iPhone (UDID), y la llave privada del certificado guardada con las mismas precauciones que la llave Android (fuera del proyecto, nunca en el repositorio ni en un informe).
4. **En el iPhone:** activar el **Modo de desarrollador** (iOS 16 o posterior), confiar en el certificado del desarrollador y mantener el teléfono desbloqueado y emparejado con el equipo. Son cambios en el teléfono que requieren tu autorización expresa.
5. **Forma de la app:** lo más pequeño sería un envoltorio con `WKWebView` (equivalente al cliente Android), en Swift sin dependencias. Un *framework* multiplataforma (por ejemplo Capacitor) necesita Node, gestor de paquetes y dependencias descargadas; no se usaría sin tu aprobación, igual que se dejó fuera Gradle.
6. **Reglas de Apple a tener en cuenta:** una app que solo muestra una web puede ser rechazada por la revisión de la App Store si no aporta funcionalidad propia; para uso personal por instalación directa no se revisa, pero sí aplican las caducidades de la cuenta gratuita.
7. **Seguridad de red:** iOS exige HTTPS para conexiones de apps salvo excepciones declaradas (App Transport Security); un coordinador en HTTP por la red local necesitaría esa excepción para direcciones locales, con las mismas advertencias que el token en HTTP sin cifrar del plan móvil.

## 3. Camino recomendado

1. **Ahora:** Safari y, si lo apruebas, la PWA (plan móvil, M4). No se necesita nada de lo anterior.
2. **Solo si falta algo que la PWA no puede dar** (por ejemplo notificaciones con la app cerrada, que además exigirían HTTPS, o comportamiento a pantalla completa más estable): decidir si hay un Mac disponible y qué cuenta de Apple se usaría. Con esa respuesta se escribiría un plan nativo con hitos propios (A–I) sin tocar el plan Android.
3. En cualquier caso, **no se declara soporte iOS nativo** hasta que una compilación real, instalada con tu autorización, funcione y se documente cómo se obtuvo.

## 4. Preguntas abiertas
- ¿Hay acceso a un Mac? ¿Propio, prestado o de alquiler?
- ¿Existe una cuenta de Apple Developer del usuario, o se usaría un Apple ID gratuito?
- ¿Qué versión de iOS tiene el iPhone 13? (cambia los requisitos de Modo de desarrollador y de Safari)
- ¿Se aceptaría una app web instalada en pantalla de inicio (PWA) como «cliente iOS» si cumple los criterios del plan móvil?
