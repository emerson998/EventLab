import { test, expect } from '@playwright/test'

async function experiment(page: import('@playwright/test').Page, scenario: string, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Novo experimento' }).click()
  await page.getByLabel('Nome do experimento').fill(name)
  await page.getByLabel('Cenário').selectOption(scenario)
  await page.getByLabel('Backoff inicial (ms)').fill('100')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Criar experimento', exact: true })
    .click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByText('Topologia do sistema')).toBeVisible()
  await page.getByRole('button', { name: 'Criar pedido', exact: true }).first().click()
  await page.getByRole('button', { name: 'Enviar pedido' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
}

test('healthy flow, event inspection and mobile layout', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await experiment(page, 'healthy', 'E2E healthy')
  await expect(page.getByText('Concluído', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Event explorer', exact: true }).click()
  await page.getByRole('button', { name: 'Inspecionar', exact: false }).first().click()
  await expect(page.getByRole('dialog')).toContainText('schema_version')
  await page.getByRole('button', { name: 'Fechar', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  expect(errors).toEqual([])
})

test('dead letter can be recovered after fixing the consumer', async ({ page }) => {
  await experiment(page, 'dead_letter', 'E2E DLQ')
  await expect(page.getByText('Tentativas esgotadas; mensagem na DLQ')).toBeVisible()
  await page.getByRole('button', { name: 'Recuperar', exact: true }).click()
  await page.getByRole('button', { name: /Entregas & DLQ/ }).click()
  await page.getByRole('button', { name: 'Reprocessar', exact: true }).click()
  await page.getByRole('button', { name: 'Laboratório', exact: true }).click()
  await expect(page.getByText('Concluído', { exact: true })).toBeVisible()
})
