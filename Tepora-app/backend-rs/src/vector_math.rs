use std::cmp::Ordering;

use candle_core::{Device, Tensor};

use crate::errors::ApiError;

pub fn cosine_similarity(query: &[f32], candidate: &[f32]) -> Result<f32, ApiError> {
    if query.is_empty() || candidate.is_empty() {
        return Err(ApiError::BadRequest(
            "Vectors must not be empty".to_string(),
        ));
    }
    if query.len() != candidate.len() {
        return Err(ApiError::BadRequest(format!(
            "Vector length mismatch: {} != {}",
            query.len(),
            candidate.len()
        )));
    }

    let device = Device::Cpu;
    let query_tensor =
        Tensor::from_slice(query, query.len(), &device).map_err(ApiError::internal)?;
    let candidate_tensor =
        Tensor::from_slice(candidate, candidate.len(), &device).map_err(ApiError::internal)?;

    let dot = (&query_tensor * &candidate_tensor)
        .map_err(ApiError::internal)?
        .sum_all()
        .map_err(ApiError::internal)?
        .to_scalar::<f32>()
        .map_err(ApiError::internal)?;

    let query_norm = l2_norm(&query_tensor)?;
    let candidate_norm = l2_norm(&candidate_tensor)?;
    let denom = query_norm * candidate_norm;
    if denom <= f32::EPSILON {
        return Ok(0.0);
    }

    Ok(dot / denom)
}

pub fn rank_descending_by_cosine(
    query: &[f32],
    candidates: &[Vec<f32>],
) -> Result<Vec<(usize, f32)>, ApiError> {
    let mut scores = Vec::with_capacity(candidates.len());
    for (idx, candidate) in candidates.iter().enumerate() {
        let score = cosine_similarity(query, candidate)?;
        scores.push((idx, score));
    }

    scores.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
    Ok(scores)
}

fn l2_norm(tensor: &Tensor) -> Result<f32, ApiError> {
    let squared = (tensor * tensor).map_err(ApiError::internal)?;
    let sum = squared.sum_all().map_err(ApiError::internal)?;
    let norm = sum.sqrt().map_err(ApiError::internal)?;
    norm.to_scalar::<f32>().map_err(ApiError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(left: f32, right: f32) -> bool {
        (left - right).abs() < 1e-5
    }

    #[test]
    fn cosine_is_one_for_identical_vectors() {
        let vec = vec![1.0, 2.0, 3.0, 4.0];
        let score = cosine_similarity(&vec, &vec).expect("cosine should work");
        assert!(approx_eq(score, 1.0));
    }

    #[test]
    fn cosine_is_zero_for_orthogonal_vectors() {
        let score = cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).expect("cosine should work");
        assert!(approx_eq(score, 0.0));
    }

    #[test]
    fn ranking_returns_highest_similarity_first() {
        let query = vec![1.0, 0.0];
        let candidates = vec![vec![0.8, 0.2], vec![0.1, 0.9], vec![0.9, 0.0]];
        let ranked = rank_descending_by_cosine(&query, &candidates).expect("ranking should work");

        assert_eq!(ranked.len(), 3);
        assert_eq!(ranked[0].0, 2);
        assert_eq!(ranked[2].0, 1);
    }
}
