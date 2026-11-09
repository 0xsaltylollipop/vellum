"""Where the plugin keeps its files."""
from pathlib import Path


def data_dir() -> Path:
    """The per-plugin data root Hermes provides (survives updates, follows the active profile)."""
    try:
        from plugins.plugin_storage import plugin_data_dir
    except ImportError:  # outside Hermes (a plain Python check of the plugin)
        d = Path.home() / ".hermes" / "plugin-data" / "vellum"
        d.mkdir(parents=True, exist_ok=True)
        return d
    return plugin_data_dir("vellum")
