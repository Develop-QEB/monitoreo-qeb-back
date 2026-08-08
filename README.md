# monitoreo-qeb-back

Back del sistema de monitoreo de QEB. Front: [monitoreo-qeb](https://github.com/Develop-QEB/monitoreo-qeb).

## Stack

Express 5 + TypeScript + Prisma + MySQL2 + bcryptjs + JWT + zod + cors + helmet + morgan.

## Setup local

```bash
npm install
cp .env.example .env      # y llena DATABASE_URL y JWT_SECRET
npm run prisma:generate
npm run prisma:push       # crea tablas en dashboard_dev
npm run seed              # crea 3 usuarios base
npm run dev               # http://localhost:4001
```

## Endpoints iniciales

- `GET  /health` — status
- `POST /api/auth/login` — `{ email, password }` → `{ token, user }`
- `POST /api/auth/logout` — protegido
- `GET  /api/auth/me` — protegido, retorna user actual
- `GET  /api/users` — admin/ti
- `POST /api/users` — admin
- `PATCH /api/users/:id/role` — admin
- `PATCH /api/users/:id/active` — admin, toggle
- `POST /api/users/:id/reset-password` — admin
- `GET  /api/audit` — admin

Todas las rutas protegidas esperan `Authorization: Bearer <jwt>`.

## Deploy

DigitalOcean App Platform. Variables de entorno en el panel del App (nunca en el repo).
