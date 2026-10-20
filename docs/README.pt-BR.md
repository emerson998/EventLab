# EventLab — laboratório de arquitetura orientada a eventos

**Injete falhas, observe mensagens e entenda as garantias do sistema.**

O EventLab combina React + TypeScript e FastAPI com um motor persistente em SQLite. Você cria pedidos e observa consumidores lógicos de pagamento, estoque e notificação, incluindo retries, mensagens duplicadas, fila de falhas e recuperação.

É um simulador local: não existem pagamentos reais, envio de e-mail ou broker externo. A persistência, as transações, o agendamento e a idempotência local são implementados; os consumidores de negócio e as falhas são simulados.

## Executar

Com Docker Desktop ou Docker Engine + Compose v2:

```bash
git clone https://github.com/emerson998/EventLab.git
cd EventLab
docker compose up --build -d
```

- Painel: http://localhost:8080
- Swagger/API: http://localhost:8000/docs
- Prontidão: http://localhost:8000/readyz

Os dados permanecem em um volume. `docker compose down` encerra os serviços sem apagar os experimentos.

## Primeiro experimento

1. Abra **Novo experimento**, escolha **Fluxo saudável** e crie o laboratório.
2. Selecione **Criar pedido** e envie os dados fictícios.
3. Observe o pedido chegar a **Concluído**: serão quatro eventos e três efeitos de negócio.
4. Em **Event explorer**, abra um evento e siga o ID de causalidade até a origem.
5. Exporte o experimento pelo botão de download ao lado dos controles.

## Cenários disponíveis

| Cenário | O que observar |
| --- | --- |
| Fluxo saudável | Pipeline completo sem falhas |
| Falha e recuperação | Pagamento falha duas vezes e se recupera com backoff |
| Tentativas esgotadas | Mensagem chega à DLQ após esgotar tentativas |
| ACK perdido | Efeito confirmado, redelivery e deduplicação pela inbox |
| Outbox em ação | Publicação interrompida por 4s e depois recuperada |
| Sem outbox | Pedido existe, mas o evento não chega ao consumidor |

Os orçamentos de falha são por experimento e consumidor, compartilhados entre pedidos. O cenário de recuperação precisa de três ou mais tentativas. Os cenários de interrupção representam a janela de falha entre commit e publicação; não encerram o processo.

## Recuperar uma mensagem da DLQ

No painel, clique em **Recuperar** no consumidor de pagamento para limpar as falhas. Depois abra **Entregas & DLQ**, localize a mensagem e clique em **Reprocessar**. Ela mantém o evento original, inicia uma nova geração de tentativas e preserva o histórico. Retome o consumidor se ele estiver pausado.

## Desenvolvimento sem Docker

Requer Python 3.11+ e Node.js 22.12+.

```bash
python -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.lock
cd backend
../.venv/bin/python -m uvicorn eventlab.main:create_app --factory --host 127.0.0.1 --port 8000
```

Em outro terminal:

```bash
cd frontend
npm ci
npm run dev
```

Abra http://localhost:5173. No PowerShell, ative `.\.venv\Scripts\Activate.ps1` a partir da raiz e use `python` no lugar dos caminhos `.venv/bin/python`. As variáveis de ambiente precisam ser definidas no shell; o Uvicorn nativo não lê `.env` automaticamente.

## Qualidade e garantias

Os testes cobrem atomicidade, rollback, concorrência com idempotency key, backoff, DLQ, replay, reinício, ACK perdido, isolamento entre experimentos, autenticação, stream HTTP e lock do agendador. O frontend inclui testes de protocolo e componentes; os testes de navegador verificam o fluxo saudável, inspeção de eventos, responsividade e recuperação da DLQ.

Cada consumidor confirma inbox, efeito e próximo evento na mesma transação. Uma redelivery não duplica o efeito local. Isso não é uma garantia de exactly-once para APIs externas. Uma implantação com broker real exigiria confirmações de publicação e outras decisões de operação.

Use somente um processo de API por banco. O lock rejeita um segundo agendador. O laboratório é compartilhado e pode usar um bearer token opcional; não oferece contas individuais, autorização por usuário ou isolamento multi-tenant.

## Documentação

- [Visão geral em inglês](../README.md)
- [Arquitetura e decisões](architecture.md)
- [Experimentos passo a passo](experiments.md)
- [API e exemplos de chamadas](api.md)
- [Execução, configuração e backup](operations.md)
- [Validação e limitações do ambiente](validation.md)
- [Evoluções planejadas](roadmap.md)

Criado por [Emerson Oliveira](https://github.com/emerson998). Licença MIT.
