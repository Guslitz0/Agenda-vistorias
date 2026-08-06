# Backend — Agenda de Vistorias

Servidor simples (Node.js + Express) que guarda os agendamentos e expõe um link de
calendário (`.ics`) que o Google Calendar e o Calendário do iPhone conseguem assinar
e manter atualizado sozinhos.

## 1. Rodar localmente (para testar)

```bash
cd agenda-backend
npm install
npm start
```

O terminal vai mostrar algo como:

```
Servidor rodando na porta 3000
Link do calendário: /agenda/8f3a91c2b4.../ics
```

Esse código depois do `/agenda/` é o seu token secreto — guarde-o, ele já foi salvo
num arquivo `.token` para você não perder.

## 2. Colocar no ar (hospedagem)

Sugestão mais simples: **Render.com** (tem plano gratuito).

1. Crie uma conta em render.com e conecte seu GitHub (suba esta pasta pra um repositório).
2. "New +" → "Web Service" → selecione o repositório.
3. Build command: `npm install`
4. Start command: `npm start`
5. Em "Environment", adicione as variáveis:
   - `CALENDAR_TOKEN` → invente uma string longa e aleatória (ex: gere uma em
     https://www.random.org/strings/ ou use `openssl rand -hex 16` no terminal).
   - `FRONTEND_ORIGIN` → o endereço de onde o app vai rodar (opcional, pode deixar em branco por enquanto).
6. Deploy. Ao terminar, você terá uma URL tipo `https://agenda-vistorias.onrender.com`.

**Atenção:** o plano gratuito do Render apaga o disco quando o serviço reinicia/reimplanta.
Como aqui os dados ficam num arquivo (`data.json`), isso significa que os agendamentos
podem ser perdidos em um redeploy. Para uso sério, ative um "Persistent Disk" (pago,
bem barato) nas configurações do serviço, ou migre para um banco de dados de verdade
(PostgreSQL) mais adiante — posso ajudar com isso quando for a hora.

## 3. Pegar o link do calendário

Com o backend no ar, o link de assinatura é:

```
https://SEU-SERVICO.onrender.com/agenda/SEU_CALENDAR_TOKEN.ics
```

## 4. Assinar no Google Calendar

Google Calendar (navegador) → engrenagem → **Configurações** → **Adicionar
calendário** → **A partir da URL** → cole o link acima → **Adicionar calendário**.

## 5. Assinar no iPhone

Ajustes → Calendário → Contas → **Adicionar Conta** → **Outro** →
**Adicionar Calendário Assinado** → cole o mesmo link (pode trocar `https://` por
`webcal://` se pedir) → **Próximo** → **Salvar**.

Os dois vão checar por atualizações periodicamente (a cada poucas horas), sem
precisar baixar nada manualmente.

## 6. Ligar o app do agendamento a este backend

No arquivo `agenda.jsx` do app, defina a constante `API_BASE_URL` no topo do arquivo
com a URL do seu backend, por exemplo:

```js
const API_BASE_URL = "https://agenda-vistorias.onrender.com";
```

Depois disso, o app passa a salvar e ler os agendamentos direto do seu servidor,
em vez do armazenamento interno do Claude — e qualquer agendamento feito por lá já
aparece automaticamente no feed do calendário.
