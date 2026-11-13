import { getApi } from '../../data/api';
import { useAsync } from '../../components/useAsync';
import Page from '../../components/Page';
import EventList from '../../components/EventList';
import ContactFooter from '../../components/ContactFooter';

export default function Calendar() {
  const { data, error, loading } = useAsync(() => getApi().listEvents());
  return (
    <Page title="Calendar" sub="Board meetings are every other month and open to all owners. Agendas post here when the board gets them." loading={loading} error={error}>
      <EventList events={data ?? []} loading={loading} error={error} />
      <ContactFooter />
    </Page>
  );
}
