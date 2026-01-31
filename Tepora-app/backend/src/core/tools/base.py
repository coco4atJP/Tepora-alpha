from abc import ABC, abstractmethod

from langchain_core.tools import BaseTool


class ToolProvider(ABC):
    """
    Abstract base class for tool providers.
    A ToolProvider is responsible for loading and managing a specific set of tools
    (e.g., Native tools, MCP tools, etc.).
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the unique name identifying this provider."""
        pass

    @abstractmethod
    async def load_tools(self) -> list[BaseTool]:
        """
        Load and return a list of tools.
        This method should handle any initialization required for the tools.
        """
        pass

    def cleanup(self):  # noqa: B027
        """
        Perform any necessary cleanup when the application shuts down.
        Default implementation does nothing.
        """
        pass
