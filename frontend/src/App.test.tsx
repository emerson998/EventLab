import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { api } from './api'

vi.mock('./api', () => ({
  api: vi.fn(),
  exportRun: vi.fn(),
  getToken: () => '',
  subscribe: vi.fn().mockResolvedValue(undefined),
}))
const mockedApi = vi.mocked(api)
beforeEach(() => {
  mockedApi.mockReset()
  mockedApi.mockResolvedValue([])
})
it('renders an honest empty workspace without making writes', async () => {
  render(<App />)
  expect(await screen.findByText('Entenda o sistema quando as coisas dão errado.')).toBeVisible()
  expect(mockedApi.mock.calls.every(([, init]) => !init?.method)).toBe(true)
})
it('opens a validated experiment form and lets the user choose a scenario', async () => {
  render(<App />)
  await screen.findByText('Entenda o sistema quando as coisas dão errado.')
  fireEvent.click(screen.getByRole('button', { name: 'Novo experimento' }))
  expect(screen.getByRole('dialog')).toBeVisible()
  fireEvent.change(screen.getByLabelText('Cenário'), {
    target: { value: 'duplicate' },
  })
  expect(screen.getByText('Redelivery · nenhum efeito de negócio duplicado.')).toBeVisible()
  expect(screen.getByLabelText('Máximo de tentativas')).toHaveValue(3)
})
it('shows backend failures as an accessible alert', async () => {
  mockedApi.mockRejectedValue(new Error('API indisponível'))
  render(<App />)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('API indisponível'))
})
it('provides all six documented experiments', async () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Guia de experimentos' }))
  expect(screen.getAllByRole('button', { name: 'Explorar cenário' })).toHaveLength(6)
  expect(screen.getByText('Sem outbox')).toBeVisible()
})
