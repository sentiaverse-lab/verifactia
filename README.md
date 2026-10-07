# VerifactIA 📺🏦

**Copiloto de inteligencia informativa que convierte información pública verificable en fichas de evidencia priorizadas y borradores listos para TV o boletines económicos — con revisión humana obligatoria.**

Proyecto para el **hackIAthon de TVN Media** ("De la señal a la decisión"). Equipo **Sentia AI** (Dimas Ramírez · Vielka Serracín).

> Diseñado contra la desinformación: la IA **no inventa** — cita fuentes verificables, se abstiene cuando no hay evidencia, y **nunca publica sin aprobación humana**.

---

## ¿Qué hace?

Vigila fuentes públicas, prioriza con el **Índice RUINE**, arma una **ficha de evidencia** con citas y un **borrador** marcado como tal, y deja la **decisión al editor**. Dos modalidades en un solo pipeline:

- 📺 **TVN Editorial** — noticias públicas verificables para televisión.
- 🏦 **Banca** — boletín del entorno económico (indicadores, ciclo histórico, mercados). Solo información pública; nunca asesoría de inversión.

## Pipeline (7 etapas)

```
Fuentes públicas → ① Ingesta única (1 captura, 2 lecturas)
                 → ② Clasificar  → ③ Agrupar duplicados
                 → ④ Cruzar indicadores → ⑤ Priorizar RUINE
                 → ⑥ Ficha de evidencia + borrador (con citas)
                 → ⑦ Revisión humana (aprobar / pedir evidencia / descartar)
```

**Índice RUINE:** `P = 30·R + 25·I + 20·U + 15·N + 10·E` (0–100). R=Relevancia, I=Impacto, U=Urgencia, N=Novedad, E=Evidencia. Niveles: bajo `[0,40)`, medio `[40,70)`, alto `[70,100]`.

## Características

- **Anti-alucinación:** abstención explícita si no hay evidencia; cita por afirmación; separa hecho / declaración / inferencia / hipótesis.
- **Rastro auditable:** cada ficha con fuente, enlace, fecha de publicación y de verificación.
- **IA en cascada** (Groq → Cerebras → enjambre) con respaldo a reglas: nunca se cae.
- **Memoria persistente:** detecta lo nuevo, no re-procesa, recuerda descartes.
- **Scheduler 24/7** (intervalo u horas fijas) con alertas al editor.
- **Panel de contexto:** sismos (USGS), clima multi-ciudad, actividad solar, indicadores del Banco Mundial, ciclo histórico (Kondratiev/Dalio) y mercados (cripto/oro/divisas), todo con fuente y sin predicción.
- **Exportación** JSON / CSV / TXT y **lectura en voz** del guion.

## Fuentes de datos (públicas)

| Fuente | Aporta | Licencia |
|---|---|---|
| TVN-2 RSS | Noticias de Panamá | Metadatos públicos |
| Banco Mundial | Indicadores macro (USD) | CC BY 4.0 |
| USGS | Sismos recientes | Dominio público |
| Open-Meteo | Clima e histórico de temperatura | Uso libre |
| NOAA | Actividad solar | Dominio público |
| CoinGecko / BCE | Mercados (cripto, oro, divisas) | Público |

## Cómo correr en local

```bash
npm install
cp .env.example .env    # rellena tus API keys (ver .env.example)
npm start               # servidor en http://localhost:4800
```

Abre `http://localhost:4800`, pulsa **Ejecutar pipeline** (procesa TVN + Banca) y explora la bandeja priorizada.

## Pruebas

```bash
npm test            # casos de aceptación T01–T10 + métricas RUINE (11/11)
npm run test:stress # robustez de la API (13/13)
```

## Despliegue

Incluye `render.yaml` para despliegue en [Render](https://render.com) (Node, plan free). Las API keys se configuran en el panel de Render, nunca en el repo.

## Principios

- Solo información **pública**. Cero datos de clientes.
- **No** es detección de fraude.
- **Human-in-the-loop**: la IA propone, el humano decide.

## Equipo — Sentia AI 🇵🇦

- **Dimas Ramírez** — Fundador · Arquitectura y desarrollo
- **Vielka Serracín** — Producto y estrategia
- 📬 sentiaverse@gmail.com · 6411-8284

## Licencia

MIT © 2026 Sentia AI
