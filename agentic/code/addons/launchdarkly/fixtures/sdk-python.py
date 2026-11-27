"""TestData fixture: https://launchdarkly.com/docs/sdk/features/test-data-sources.md
Requires an already installed launchdarkly-server-sdk v8+; no real credentials.
"""
from ldclient import LDClient, Config, Context
from ldclient.integrations.test_data import TestData
import json

source = TestData.data_source()
source.update(source.flag("checkout").variation_for_all(False))
client = LDClient(config=Config("offline-test-only", update_processor_class=source,
                               send_events=False), start_wait=5)
try:
    assert client.is_initialized()
    context = Context.create("fixture-user")
    for state in (False, True):
        source.update(source.flag("checkout").variation_for_all(state))
        assert client.variation("checkout", context, False) is state
    assert client.variation("missing", context, False) is False
    print(json.dumps({"language": "python", "off_exit_code": 0, "on_exit_code": 0}))
finally:
    try:
        client.flush()
    finally:
        client.close()
