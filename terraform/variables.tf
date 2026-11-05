variable "instance_id" {
  description = "Existing EC2 instance ID"
  type        = string
}

variable "vpc_id" {
  description = "Existing VPC ID"
  type        = string
}

variable "subnet_id" {
  description = "Existing subnet ID"
  type        = string
}

variable "security_group_id" {
  description = "Existing EC2 security group ID"
  type        = string
}

variable "ecr_repository_names" {
  description = "Existing ECR repository names"
  type        = list(string)
}
