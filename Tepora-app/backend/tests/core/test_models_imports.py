import inspect


def test_core_models_imports():
    # Importing the public package should not raise (regression test for P0-1).
    from src.core.models import ModelManager  # noqa: F401
    from src.core.models.types import (  # noqa: F401
        ModelModality,
        ModelPool,
        ModelRole,
        ProgressCallback,
    )

    assert ModelPool is ModelModality
    assert ModelRole is ModelPool
    assert callable(ProgressCallback)


def test_download_from_huggingface_accepts_role_kwarg():
    from src.core.models import ModelManager

    sig = inspect.signature(ModelManager.download_from_huggingface)
    assert "role" in sig.parameters
    assert sig.parameters["role"].kind is inspect.Parameter.KEYWORD_ONLY
