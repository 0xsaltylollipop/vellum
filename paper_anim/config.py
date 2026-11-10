"""Where the plugin keeps its files."""
from pathlib import Path


def data_dir() -> Path:
    """The per-plugin data root Hermes provides (survives updates, follows the active profile). Resolved on every call,
    so each profile gets its own files; outside Hermes there is no data folder at all (tests point it elsewhere)."""
    from plugins.plugin_storage import plugin_data_dir
    return Path(plugin_data_dir("vellum"))
