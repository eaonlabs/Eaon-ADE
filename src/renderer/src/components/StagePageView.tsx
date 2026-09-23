import type { StagePage } from '../store/useStore'
import { AutomationsPage } from './AutomationsPage'
import { PagesPage } from './PagesPage'
import { PullRequestsPage } from './PullRequestsPage'
import { SearchPage } from './SearchPage'

/**
 * The rail's non-workspace destinations, on the stage.
 *
 * Only the switch. Each destination is its own component with its own state
 * and its own data source — Pull requests reads `gh`, Pages reads the repo's
 * markdown, Automations reads saved prompts — and none of them knows the
 * others exist. `cwd` is the workspace you were last in, because every one of
 * them is a question about *this* project.
 */
export function StagePageView({
  page,
  cwd
}: {
  page: StagePage
  cwd: string
}): React.JSX.Element {
  if (page === 'search') return <SearchPage cwd={cwd} />
  if (page === 'automations') return <AutomationsPage />
  if (page === 'pulls') return <PullRequestsPage cwd={cwd} />
  return <PagesPage cwd={cwd} />
}
