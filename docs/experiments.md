# Reproducible experiments

The UI is in Portuguese. Each experiment is isolated by run ID, with independent consumer settings and history. Create a fresh experiment for each comparison; presets configure run-level fault budgets, not a fault budget per order.

## 1. Establish a baseline

1. Select **Novo experimento → Fluxo saudável**; keep 3 attempts and 1,000ms backoff.
2. Select **Criar pedido → Enviar pedido**.
3. Observe payment, inventory and notification on the topology.
4. Expect a completed order, 4 events, 3 effects, 3 confirmed deliveries, 0 DLQ messages.
5. Open **Event explorer** and inspect `notification.sent`. Its causation link walks backwards to the original `order.created` event.

Default delivery latency is 400ms per hop; the 150ms scheduler tick adds some scheduling overhead. This is not a latency benchmark.

## 2. Recover from transient failure

1. Create **Falha e recuperação** and submit an order.
2. Payment consumes two injected failures; delivery state becomes `retry`.
3. Inspect the journal for the first 1s and second 2s backoff.
4. The third attempt succeeds. The order eventually completes.

Pausing payment leaves the message queued. Resuming does not reset the attempt counter. Changing latency applies only to future deliveries.

## 3. Inspect and recover a dead letter

1. Create **Tentativas esgotadas** and submit an order.
2. Wait for the **DEAD-LETTER QUEUE** metric to become 1.
3. Select **Recuperar** in the payment fault controls. This clears injected failures and lost-ACK settings; it does not automatically resume a paused consumer.
4. Open **Entregas & DLQ**, filter **Dead letter**, and select **Reprocessar**.
5. The same delivery returns to the queue with `generation=1`, a fresh attempt budget and the original event ID.
6. Observe a completed order and no remaining dead letters.

Replaying before fixing the fault repeats the failure. Replaying a delivery outside the DLQ returns HTTP 409.

## 4. Lose an acknowledgement

1. Create **ACK perdido** and submit an order.
2. Payment applies its effect and produces `payment.approved`.
3. The simulator schedules redelivery because the logical acknowledgement is lost.
4. The inbox recognizes the original event and marks the delivery deduplicated.
5. Expect 3 total effects and 4 events, not a second payment effect.

You can also select the copy button on a delivery to create a manual redelivery. The original event ID is preserved. This action is useful after an order is already complete: replaying the event must not regress the order state.

## 5. Compare the publication gap

### With outbox

Create **Outbox em ação** and submit an order. The order and publication intent exist immediately; the relay waits four seconds. Restarting the API during this gap preserves the intent. The order completes after the relay resumes.

### Without outbox

Create **Sem outbox** and submit an order. The order exists, but the event publication is intentionally lost. There is no payment delivery and the order remains **Criado**. The event envelope and `event.lost` journal row are audit evidence of the simulated gap, not proof of delivery.

Both presets automatically enable the publication gap for each new order. The order form also lets you inject it manually. The fault model does not kill the application.

## 6. Test persistence

With a run paused or a delivery awaiting retry:

```bash
docker compose restart api
```

Refresh the UI if necessary. The selected run, order, inbox, fault budgets and due times survive because the named volume is preserved. A delay that elapsed while the API was down is immediately eligible after restart, subject to pause settings.

## Export evidence

The export button next to the experiment controls downloads JSON with all events, deliveries, effects and the full journal. Include it when discussing a failure or reporting an issue. It can contain customer/product names entered into the lab; use fictional data. Export is read-only and there is no import endpoint.
