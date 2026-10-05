<!-- PLACEHOLDER: apuntes de ejemplo. Reemplázalos con tus apuntes reales. -->
# Qué es MCP

MCP (Model Context Protocol) es un protocolo abierto que estandariza cómo una aplicación de IA se conecta con herramientas y fuentes de datos externas.

La documentación oficial lo compara con un puerto USB-C para aplicaciones de IA: un solo conector en lugar de un cable distinto para cada dispositivo.

# El problema que resuelve

Sin un estándar, cada modelo necesita una integración a medida con cada herramienta. Con N modelos y M herramientas terminas manteniendo N×M integraciones.

Con MCP cada herramienta se expone una vez como servidor y cualquier aplicación compatible la puede usar: el problema pasa de N×M a N+M.

# Arquitectura

- Host: la aplicación donde vive el modelo (un IDE, un chat de escritorio, tu propio agente).
- Cliente: el componente dentro del host que mantiene la conexión con un servidor.
- Servidor: el programa que expone capacidades al modelo.

Un servidor MCP ofrece tres tipos de cosas: herramientas (acciones que el modelo puede ejecutar), recursos (datos que puede leer) y prompts (plantillas reutilizables).

Los mensajes viajan en JSON-RPC. Un servidor puede correr local (por stdio) o remoto (por HTTP).

# Dato que vi en redes y no verifiqué

El 90% de las startups de IA ya usan MCP en producción.
